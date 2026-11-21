/**
 * 验证同步事务语义：提交、异常回滚、异步回调拒绝、保存点局部回滚、嵌套事务拒绝，
 * 以及 ROLLBACK 失败后连接被标记不可用并保留根因。
 * 依赖存储模块测试助手与存储端口契约。
 * 禁止在测试中执行真实网络、让测试共享数据目录或忽略回滚后的残留数据断言。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { DomainError, type ScopedBranchStorage, type StoragePort, type StorageTable, type StorageTransaction } from "@ai-npc/contracts";
import { SqliteStorage } from "../src/sqlite/storage";
import {
  createFakeHost,
  createTempDataDir,
  expectDomainError,
  openStorageHarness,
  removeTempDataDir,
} from "./support";

const BRANCH_ID = "brn-tx";

/** 捕获一次同步抛错，便于断言错误类型与根因。 */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function writeAggregate(tx: StorageTransaction, aggregateId: string): void {
  tx.branch(BRANCH_ID)
    .table("aggregate_state")
    .put({
      aggregate_type: "stockpile",
      aggregate_id: aggregateId,
      version: 1,
      state_json: { amount: 10 },
    });
}

describe("同步事务", () => {
  it("提交状态、事件、job 与 receipt 后可以读回", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        const branch = tx.branch(BRANCH_ID);
        writeAggregate(tx, "stk-1");
        branch.table("domain_events").put({
          world_seq: 1,
          event_id: "evt-1",
          world_tick: 5,
          type: "TestHappened",
          schema_version: 1,
          principal_id: "player-1",
          causation_ids_json: [],
          correlation_id: "corr-1",
          audience_json: [],
          payload_json: { ok: true },
          committed_at: "2026-01-01T00:00:00.000Z",
        });
        branch.table("jobs").put({
          job_id: "job-1",
          seq: 1,
          kind: "daily-settle",
          due_tick: 10,
          status: "scheduled",
          idempotency_key: "daily:10",
          payload_json: {},
          attempts: 0,
          last_error: null,
        });
        branch.table("command_receipts").put({
          principal_id: "player-1",
          command_id: "cmd-1",
          command_type: "campaign.start",
          payload_hash: "hash-1",
          receipt_json: { commandStatus: "accepted" },
          created_at: "2026-01-01T00:00:00.000Z",
        });
      });

      const counts = harness.port.transact((tx) => {
        const branch = tx.branch(BRANCH_ID);
        return {
          aggregates: branch.table("aggregate_state").count(),
          events: branch.table("domain_events").count(),
          jobs: branch.table("jobs").count(),
          receipts: branch.table("command_receipts").count(),
        };
      });
      expect(counts).toEqual({ aggregates: 1, events: 1, jobs: 1, receipts: 1 });
    } finally {
      await harness.dispose();
    }
  });

  it("回调抛错时状态、事件、job 与 receipt 都不落库", async () => {
    const harness = await openStorageHarness();
    try {
      let captured: StorageTransaction | null = null;
      let capturedTable: StorageTable | null = null;
      expect(() =>
        harness.port.transact((tx) => {
          captured = tx;
          const branch = tx.branch(BRANCH_ID);
          capturedTable = branch.table("aggregate_state");
          writeAggregate(tx, "stk-rollback");
          branch.table("domain_events").put({
            world_seq: 1,
            event_id: "evt-rollback",
            world_tick: 1,
            type: "TestHappened",
            schema_version: 1,
            principal_id: "player-1",
            causation_ids_json: [],
            correlation_id: "corr-rollback",
            audience_json: [],
            payload_json: {},
            committed_at: "2026-01-01T00:00:00.000Z",
          });
          branch.table("jobs").put({
            job_id: "job-rollback",
            seq: 1,
            kind: "noop",
            due_tick: 1,
            status: "scheduled",
            idempotency_key: "noop:1",
            payload_json: {},
          });
          branch.table("command_receipts").put({
            principal_id: "player-1",
            command_id: "cmd-rollback",
            command_type: "campaign.start",
            payload_hash: "hash-rollback",
            receipt_json: {},
            created_at: "2026-01-01T00:00:00.000Z",
          });
          throw new Error("处理器失败");
        }),
      ).toThrow("处理器失败");

      const counts = harness.port.transact((tx) => {
        const branch = tx.branch(BRANCH_ID);
        return {
          aggregates: branch.table("aggregate_state").count(),
          events: branch.table("domain_events").count(),
          jobs: branch.table("jobs").count(),
          receipts: branch.table("command_receipts").count(),
        };
      });
      expect(counts).toEqual({ aggregates: 0, events: 0, jobs: 0, receipts: 0 });
      const transaction = captured as StorageTransaction | null;
      expect(transaction).not.toBeNull();
      expectDomainError(() => (transaction as StorageTransaction).run("SELECT 1"), "invalid-state");
      expectDomainError(
        () => (capturedTable as StorageTable).list(),
        "invalid-state",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("事务回调返回 Promise 时回滚并抛错", async () => {
    const harness = await openStorageHarness();
    try {
      expect(() =>
        harness.port.transact(async () => {
          await Promise.resolve();
          return "later";
        }),
      ).toThrow("不能返回 Promise");
      const value = harness.port.transact((tx) => tx.get("SELECT 1 AS value")?.["value"]);
      expect(value).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("committed transactions invalidate derived table and branch handles", async () => {
    const harness = await openStorageHarness();
    try {
      let rowsHandle: StorageTable | null = null;
      let branchHandle: ScopedBranchStorage | null = null;
      let branchTableHandle: StorageTable | null = null;
      harness.port.transact((tx) => {
        rowsHandle = tx.rows("worlds");
        branchHandle = tx.branch(BRANCH_ID);
        branchTableHandle = branchHandle.table("aggregate_state");
        branchTableHandle.put({
          aggregate_type: "stockpile",
          aggregate_id: "stk-open",
          version: 1,
          state_json: { amount: 10 },
        });
      });

      const rows = rowsHandle as StorageTable | null;
      const branch = branchHandle as ScopedBranchStorage | null;
      const branchTable = branchTableHandle as StorageTable | null;
      expect(rows).not.toBeNull();
      expect(branch).not.toBeNull();
      expect(branchTable).not.toBeNull();
      expectDomainError(
        () =>
          (rows as StorageTable).put({
            world_id: "wld-after-commit",
            pack_id: "earth-2964-v1",
            content_version: "0.3.0",
            created_at: "2026-01-01T00:00:00.000Z",
          }),
        "invalid-state",
      );
      expectDomainError(
        () => (branch as ScopedBranchStorage).table("aggregate_state"),
        "invalid-state",
      );
      expectDomainError(
        () => (branchTable as StorageTable).get({ aggregate_type: "stockpile", aggregate_id: "stk-open" }),
        "invalid-state",
      );
      expectDomainError(
        () =>
          (branchTable as StorageTable).put({
            aggregate_type: "stockpile",
            aggregate_id: "stk-after-commit",
            version: 1,
            state_json: { amount: 1 },
          }),
        "invalid-state",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("保存点内抛错只回滚保存点之后的写入", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_ID).table("aggregate_state");
        writeAggregate(tx, "outer");
        expect(() =>
          tx.savepoint("inner", () => {
            writeAggregate(tx, "inner");
            throw new Error("保存点内失败");
          }),
        ).toThrow("保存点内失败");
        expect(table.count()).toBe(1);
        expect(table.get({ aggregate_type: "stockpile", aggregate_id: "outer" })).not.toBeNull();
        expect(table.get({ aggregate_type: "stockpile", aggregate_id: "inner" })).toBeNull();
      });
      const remaining = harness.port.transact((tx) =>
        tx
          .branch(BRANCH_ID)
          .table("aggregate_state")
          .list(undefined, { orderBy: [{ column: "aggregate_id" }] })
          .map((row) => row["aggregate_id"]),
      );
      expect(remaining).toEqual(["outer"]);
    } finally {
      await harness.dispose();
    }
  });

  it("保存点成功时释放并保留写入", async () => {
    const harness = await openStorageHarness();
    try {
      const ids = harness.port.transact((tx) => {
        writeAggregate(tx, "outer");
        return tx.savepoint("inner", () => {
          writeAggregate(tx, "inner");
          return tx
            .branch(BRANCH_ID)
            .table("aggregate_state")
            .list(undefined, { orderBy: [{ column: "aggregate_id" }] })
            .map((row) => row["aggregate_id"]);
        });
      });
      expect(ids).toEqual(["inner", "outer"]);
    } finally {
      await harness.dispose();
    }
  });

  it("非法保存点名与嵌套事务都被拒绝", async () => {
    const harness = await openStorageHarness();
    try {
      expectDomainError(
        () => harness.port.transact((tx) => tx.savepoint("bad;drop", () => 1)),
        "validation",
      );
      expectDomainError(
        () =>
          harness.port.transact(() => {
            harness.port.transact(() => 1);
          }),
        "invalid-state",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("ROLLBACK 失败后连接标记不可用，后续调用立即返回带根因的领域错误", async () => {
    const harness = await openStorageHarness();
    const internal = harness.port as unknown as { readonly database: DatabaseSync | null };
    const database = internal.database;
    if (database === null) {
      throw new Error("存储适配器尚未打开");
    }
    const originalExec = database.exec.bind(database);
    const execSpy = vi.spyOn(database, "exec").mockImplementation((sql: string) => {
      if (sql.trim().toUpperCase() === "ROLLBACK") {
        throw new Error("注入的 ROLLBACK 失败");
      }
      originalExec(sql);
    });
    try {
      const originalError = new Error("处理器失败");
      let failedTransaction: StorageTransaction | null = null;
      const first = captureError(() =>
        harness.port.transact((tx) => {
          failedTransaction = tx;
          throw originalError;
        }),
      );
      expect(first).toBeInstanceOf(DomainError);
      expect((first as DomainError).code).toBe("invalid-state");
      expect((first as DomainError).safeMessage).toContain("回滚失败");

      // 连接已被标记不可用：后续读写立即失败，根因包含原始错误与 ROLLBACK 失败，而非模糊的 SQLite 事务错误。
      expect((harness.port as StoragePort & { readonly isOpen: boolean }).isOpen).toBe(false);
      const second = captureError(() => harness.port.transact((tx) => tx.get("SELECT 1 AS value")));
      expect(second).toBeInstanceOf(DomainError);
      expect((second as DomainError).code).toBe("invalid-state");
      expect((second as DomainError).safeMessage).toContain("不可用");
      const cause = (second as DomainError).cause as
        | { readonly rollbackError?: unknown; readonly originalError?: unknown }
        | null;
      expect(cause).not.toBeNull();
      expect(cause?.rollbackError).toBeInstanceOf(Error);
      expect((cause?.rollbackError as Error).message).toBe("注入的 ROLLBACK 失败");
      expect((cause?.originalError as Error).message).toBe("处理器失败");

      // 分支复制与整库备份同样先经过 requireDatabase，不能继续使用失效连接。
      const transaction = failedTransaction as StorageTransaction | null;
      expect(transaction).not.toBeNull();
      const forkFailure = captureError(() =>
        harness.port.forkBranch(transaction as StorageTransaction, {
          srcBranchId: BRANCH_ID,
          dstBranchId: "brn-tx-fork",
          kind: "experiment",
          runId: "run-tx-fork",
        }),
      );
      expect(forkFailure).toBeInstanceOf(DomainError);
      expect((forkFailure as DomainError).code).toBe("invalid-state");
      expect((forkFailure as DomainError).safeMessage).toContain("不可用");
      const backupFailure = captureError(() => harness.port.backup());
      expect(backupFailure).toBeInstanceOf(DomainError);
      expect((backupFailure as DomainError).code).toBe("invalid-state");
      expect((backupFailure as DomainError).safeMessage).toContain("不可用");
    } finally {
      execSpy.mockRestore();
      await harness.dispose();
    }
  });

  it("回滚失败后成功关闭连接会清除不可用状态并允许重新打开", async () => {
    const dataDir = createTempDataDir();
    const storage = new SqliteStorage({ dataDir, inlineArtifactMaxBytes: 65536 }, createFakeHost());
    let execSpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      await storage.open();
      const internal = storage as unknown as { readonly database: DatabaseSync | null };
      const database = internal.database;
      if (database === null) {
        throw new Error("存储适配器尚未打开");
      }
      const originalExec = database.exec.bind(database);
      execSpy = vi.spyOn(database, "exec").mockImplementation((sql: string) => {
        if (sql.trim().toUpperCase() === "ROLLBACK") {
          throw new Error("注入的 ROLLBACK 失败");
        }
        originalExec(sql);
      });
      const failure = captureError(() =>
        storage.transact(() => {
          throw new Error("处理器失败");
        }),
      );
      expect(failure).toBeInstanceOf(DomainError);
      expect(storage.isOpen).toBe(false);

      execSpy.mockRestore();
      execSpy = null;
      storage.close();
      expect(storage.isOpen).toBe(false);

      // 关闭成功清除不可用标记，重新打开后可以继续读写。
      await storage.open();
      expect(storage.isOpen).toBe(true);
      expect(storage.transact((tx) => tx.get("SELECT 1 AS value")?.["value"])).toBe(1);
    } finally {
      execSpy?.mockRestore();
      storage.close();
      removeTempDataDir(dataDir);
    }
  });

  it("未打开时端口返回 not-ready", async () => {
    const harness = await openStorageHarness();
    try {
      await harness.dispose();
      expectDomainError(() => harness.port.transact(() => 1), "not-ready");
    } finally {
      // dispose 已执行，临时目录已清理。
    }
  });
});
