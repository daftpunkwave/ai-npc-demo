/**
 * 验证同步事务语义：提交、异常回滚、异步回调拒绝、保存点局部回滚与嵌套事务拒绝。
 * 依赖存储模块测试助手与存储端口契约。
 * 禁止在测试中执行真实网络、让测试共享数据目录或忽略回滚后的残留数据断言。
 */
import { describe, expect, it } from "vitest";
import type { StorageTransaction } from "@ai-npc/contracts";
import { expectDomainError, openStorageHarness } from "./support";

const BRANCH_ID = "brn-tx";

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
      expect(() =>
        harness.port.transact((tx) => {
          captured = tx;
          const branch = tx.branch(BRANCH_ID);
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
