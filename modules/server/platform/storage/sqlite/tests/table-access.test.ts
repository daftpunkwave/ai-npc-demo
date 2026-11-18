/**
 * 验证表级 scope 读写：JSON 编解码、分支隔离、等值过滤、排序分页、主键校验与 upsert。
 * 依赖存储模块测试助手与存储端口契约。
 * 禁止绕过 scoped 分支接口直接访问分支级表，或让测试依赖未声明的默认行序。
 */
import { describe, expect, it } from "vitest";
import type { StorageRow } from "@ai-npc/contracts";
import { expectDomainError, openStorageHarness } from "./support";

const BRANCH_A = "brn-a";
const BRANCH_B = "brn-b";

function eventRow(worldSeq: number): StorageRow {
  return {
    world_seq: worldSeq,
    event_id: `evt-${worldSeq}`,
    world_tick: worldSeq,
    type: "TestHappened",
    schema_version: 1,
    principal_id: "player-1",
    causation_ids_json: [],
    correlation_id: `corr-${worldSeq}`,
    audience_json: [],
    payload_json: { seq: worldSeq },
    committed_at: "2026-01-01T00:00:00.000Z",
  };
}

function jobRow(seq: number, dueTick: number, status = "scheduled"): StorageRow {
  return {
    job_id: `job-${seq}`,
    seq,
    kind: "daily-settle",
    due_tick: dueTick,
    status,
    idempotency_key: `daily:${seq}`,
    payload_json: {},
    attempts: 0,
    last_error: null,
  };
}

function aggregateRow(aggregateId: string, version: number): StorageRow {
  return {
    aggregate_type: "stockpile",
    aggregate_id: aggregateId,
    version,
    state_json: { amount: version * 10 },
  };
}

describe("JSON 列编解码", () => {
  it("写入对象按规范 JSON 落库，读出还原为对象", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        tx.branch(BRANCH_A)
          .table("aggregate_state")
          .put({
            aggregate_type: "stockpile",
            aggregate_id: "stk-1",
            version: 1,
            state_json: { zeta: 1, alpha: [true, null, "文本"] },
          });
      });
      harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_A).table("aggregate_state");
        expect(table.get({ aggregate_type: "stockpile", aggregate_id: "stk-1" })?.["state_json"]).toEqual({
          zeta: 1,
          alpha: [true, null, "文本"],
        });
        const raw = tx.get(
          "SELECT state_json FROM aggregate_state WHERE branch_id = ? AND aggregate_type = ? AND aggregate_id = ?",
          [BRANCH_A, "stockpile", "stk-1"],
        );
        expect(raw?.["state_json"]).toBe('{"alpha":[true,null,"文本"],"zeta":1}');
      });
    } finally {
      await harness.dispose();
    }
  });
});

describe("分支 scope 隔离", () => {
  it("分支级表只能在绑定分支的接口内读写", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        tx.branch(BRANCH_A).table("domain_events").put(eventRow(1));
      });
      const counts = harness.port.transact((tx) => ({
        a: tx.branch(BRANCH_A).table("domain_events").count(),
        b: tx.branch(BRANCH_B).table("domain_events").count(),
      }));
      expect(counts).toEqual({ a: 1, b: 0 });
      expectDomainError(
        () => harness.port.transact((tx) => tx.rows("domain_events")),
        "validation",
      );
      expectDomainError(
        () => harness.port.transact((tx) => tx.branch(BRANCH_A).table("worlds")),
        "validation",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝与 scope 不一致的 branch_id 与重复指定分支列", async () => {
    const harness = await openStorageHarness();
    try {
      expectDomainError(
        () =>
          harness.port.transact((tx) => {
            tx.branch(BRANCH_A)
              .table("domain_events")
              .put({ ...eventRow(1), branch_id: BRANCH_B });
          }),
        "validation",
      );
      expectDomainError(
        () =>
          harness.port.transact((tx) => {
            tx.branch(BRANCH_A)
              .table("domain_events")
              .get({ branch_id: BRANCH_A, world_seq: 1 });
          }),
        "validation",
      );
    } finally {
      await harness.dispose();
    }
  });
});

describe("过滤、排序与分页", () => {
  it("等值过滤、排序、limit 与 offset", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_A).table("jobs");
        table.put(jobRow(1, 30));
        table.put(jobRow(2, 10, "done"));
        table.put(jobRow(3, 20));
      });
      const listing = harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_A).table("jobs");
        return {
          scheduled: table.list({ status: "scheduled" }, { orderBy: [{ column: "due_tick" }] }).map((row) => row["seq"]),
          desc: table
            .list(undefined, { orderBy: [{ column: "due_tick", direction: "desc" }] })
            .map((row) => row["seq"]),
          page: table.list(undefined, { orderBy: [{ column: "seq" }], limit: 1, offset: 1 }).map((row) => row["seq"]),
          offsetOnly: table.list(undefined, { orderBy: [{ column: "seq" }], offset: 2 }).map((row) => row["seq"]),
        };
      });
      expect(listing).toEqual({ scheduled: [3, 1], desc: [1, 3, 2], page: [2], offsetOnly: [3] });
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝未知列、非法方向与负数分页", async () => {
    const harness = await openStorageHarness();
    try {
      const operations: readonly (() => unknown)[] = [
        () => harness.port.transact((tx) => tx.branch(BRANCH_A).table("jobs").list({ missing: 1 })),
        () =>
          harness.port.transact((tx) =>
            tx.branch(BRANCH_A).table("jobs").list(undefined, {
              orderBy: [{ column: "seq", direction: "down" as "asc" }],
            }),
          ),
        () => harness.port.transact((tx) => tx.branch(BRANCH_A).table("jobs").list(undefined, { limit: -1 })),
        () => harness.port.transact((tx) => tx.branch(BRANCH_A).table("jobs").count({ missing: 1 })),
      ];
      for (const operation of operations) {
        expectDomainError(operation, "validation");
      }
    } finally {
      await harness.dispose();
    }
  });
});

describe("主键读写与 upsert", () => {
  it("按主键读取、更新与删除", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        tx.branch(BRANCH_A).table("aggregate_state").put(aggregateRow("stk-1", 1));
      });
      harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_A).table("aggregate_state");
        table.put(aggregateRow("stk-1", 2));
        expect(table.count()).toBe(1);
        expect(table.get({ aggregate_type: "stockpile", aggregate_id: "stk-1" })?.["version"]).toBe(2);
        expect(table.get({ aggregate_type: "stockpile", aggregate_id: "stk-2" })).toBeNull();
        expect(table.delete({ aggregate_type: "stockpile", aggregate_id: "stk-1" })).toEqual({ changes: 1 });
        expect(table.count()).toBe(0);
      });
    } finally {
      await harness.dispose();
    }
  });

  it("max 返回指定列的最大值", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_A).table("jobs");
        table.put(jobRow(1, 10));
        table.put(jobRow(2, 20));
        table.put(jobRow(3, 30, "done"));
      });
      const maximum = harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_A).table("jobs");
        return {
          all: table.max("seq"),
          scheduled: table.max("seq", { status: "scheduled" }),
          empty: table.max("seq", { status: "cancelled" }),
        };
      });
      expect(maximum).toEqual({ all: 3, scheduled: 2, empty: null });
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝缺少主键列或含未知列的写入行", async () => {
    const harness = await openStorageHarness();
    try {
      expectDomainError(
        () =>
          harness.port.transact((tx) => {
            tx.branch(BRANCH_A)
              .table("aggregate_state")
              .put({ aggregate_type: "stockpile", version: 1, state_json: {} });
          }),
        "validation",
      );
      expectDomainError(
        () =>
          harness.port.transact((tx) => {
            tx.branch(BRANCH_A)
              .table("aggregate_state")
              .put({ ...aggregateRow("stk-9", 1), unknown_column: 1 });
          }),
        "validation",
      );
      expectDomainError(
        () =>
          harness.port.transact((tx) => {
            tx.branch(BRANCH_A).table("aggregate_state").get({ aggregate_type: "stockpile" });
          }),
        "validation",
      );
    } finally {
      await harness.dispose();
    }
  });
});

describe("原始查询与 BLOB", () => {
  it("原始查询绑定参数，BLOB 列往返保持字节", async () => {
    const harness = await openStorageHarness();
    try {
      const body = new Uint8Array([0, 1, 2, 255]);
      harness.port.transact((tx) => {
        tx.rows("artifacts").put({
          artifact_id: "art-1",
          run_id: "run-1",
          kind: "context",
          content_hash: "hash-1",
          mime: "application/octet-stream",
          byte_size: body.byteLength,
          storage: "inline",
          body,
          file_path: null,
          redaction: "raw",
          redacted_from: null,
          created_at: "2026-01-01T00:00:00.000Z",
        });
      });
      const read = harness.port.transact((tx) => {
        const row = tx.rows("artifacts").get({ artifact_id: "art-1" });
        const raw = tx.get("SELECT body FROM artifacts WHERE artifact_id = ?", ["art-1"]);
        const selected = tx.all("SELECT artifact_id FROM artifacts WHERE kind = ?", ["context"]);
        return { row, raw, selected };
      });
      expect(read.row?.["body"]).toBeInstanceOf(Uint8Array);
      expect([...(read.row?.["body"] as Uint8Array)]).toEqual([0, 1, 2, 255]);
      expect(read.raw?.["body"]).toBeInstanceOf(Uint8Array);
      expect(read.selected.map((row) => row["artifact_id"])).toEqual(["art-1"]);
    } finally {
      await harness.dispose();
    }
  });

  it("原始写入可以回滚且参数必须为标量", async () => {
    const harness = await openStorageHarness();
    try {
      expect(() =>
        harness.port.transact((tx) => {
          tx.run("INSERT INTO worlds (world_id, pack_id, content_version, created_at) VALUES (?, ?, ?, ?)", [
            "wld-raw",
            "earth-2964-v1",
            "v1",
            "2026-01-01T00:00:00.000Z",
          ]);
          throw new Error("回滚原始写入");
        }),
      ).toThrow("回滚原始写入");
      const count = harness.port.transact((tx) => tx.get("SELECT COUNT(*) AS total FROM worlds")?.["total"]);
      expect(count).toBe(0);
    } finally {
      await harness.dispose();
    }
  });
});
