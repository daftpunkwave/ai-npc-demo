/**
 * 验证分支复制的数据面：branches 行、全部分支级表逐行拷贝、时钟/租约/激活/trigger 修正与 job seq 保持。
 * 依赖分支复制测试种子数据与存储模块测试助手。
 * 禁止只校验行数而忽略逐行相等、让新分支沿用控制 epoch，或复制运行级 turn。
 */
import { describe, expect, it } from "vitest";
import { BRANCH_TABLES } from "../src/sqlite/schema";
import { SRC, TABLES_EXPECTED_EQUAL, forkInto, seedSourceBranch, snapshotTable } from "./fork-support";
import { openStorageHarness } from "./support";

describe("分支复制", () => {
  it("复制全部分支级表并写入快照分支行", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      const result = harness.port.transact((tx) =>
        harness.port.forkBranch(tx, { srcBranchId: SRC, dstBranchId: "brn-snap", kind: "snapshot" }),
      );
      expect(result).toMatchObject({
        branchId: "brn-snap",
        parentBranchId: SRC,
        kind: "snapshot",
        status: "frozen",
        runId: null,
        forkedAtWorldSeq: 3,
      });
      expect(Object.keys(result.copiedRows).sort()).toEqual([...BRANCH_TABLES].sort());
      expect(result.copiedRows["domain_events"]).toBe(3);
      expect(result.copiedRows["jobs"]).toBe(3);
      expect(result.copiedRows["triggers"]).toBe(6);
      for (const table of TABLES_EXPECTED_EQUAL) {
        expect(snapshotTable(harness.port, "brn-snap", table)).toEqual(snapshotTable(harness.port, SRC, table));
      }
      const branchRow = harness.port.transact((tx) => tx.rows("branches").get({ branch_id: "brn-snap" }));
      expect(branchRow).toMatchObject({ world_id: "wld-1", kind: "snapshot", status: "frozen" });
      expect(branchRow?.["forked_at_world_seq"]).toBe(3);
      expect(branchRow?.["run_id"]).toBeNull();
      const turnCount = harness.port.transact((tx) => tx.get("SELECT COUNT(*) AS total FROM turn_runs")?.["total"]);
      expect(turnCount).toBe(5);
    } finally {
      await harness.dispose();
    }
  });

  it("时钟暂停、run_version 与租约 epoch 递增、激活状态置为 dormant", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      forkInto(harness.port, "brn-snap", "snapshot");
      const fixups = harness.port.transact((tx) => {
        const dst = tx.branch("brn-snap");
        return {
          clock: dst.table("clock").get({}),
          lease: dst.table("controller_leases").get({ agent_id: "agt-cenyan" }),
          activation: dst.table("agent_activations").get({ agent_id: "agt-cenyan" }),
          sourceClock: tx.branch(SRC).table("clock").get({}),
        };
      });
      expect(fixups.clock).toMatchObject({ world_tick: 42, mode: "paused", run_version: 4, step_target_tick: 50 });
      expect(fixups.lease?.["controller_epoch"]).toBe(5);
      expect(fixups.activation?.["status"]).toBe("dormant");
      expect(fixups.sourceClock?.["mode"]).toBe("running");
      expect(fixups.sourceClock?.["run_version"]).toBe(3);
    } finally {
      await harness.dispose();
    }
  });

  it("未完成 turn 消费的 trigger 被释放，已完成 turn 消费的 trigger 被删除", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      forkInto(harness.port, "brn-snap", "snapshot");
      const triggers = harness.port.transact((tx) =>
        tx
          .branch("brn-snap")
          .table("triggers")
          .list(undefined, { orderBy: [{ column: "trigger_id" }] })
          .map((row) => ({ id: row["trigger_id"], consumed: row["consumed_by_turn_id"] })),
      );
      expect(triggers).toEqual([
        { id: "t-cancelled", consumed: null },
        { id: "t-deciding", consumed: null },
        { id: "t-none", consumed: null },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("job 的 seq 在分支内连续递增，fork 后保持不变", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      forkInto(harness.port, "brn-snap", "snapshot");
      const before = harness.port.transact((tx) =>
        tx
          .branch("brn-snap")
          .table("jobs")
          .list(undefined, { orderBy: [{ column: "seq" }] })
          .map((row) => row["seq"]),
      );
      expect(before).toEqual([1, 2, 3]);
      const nextSeq = harness.port.transact((tx) => Number(tx.branch("brn-snap").table("jobs").max("seq")) + 1);
      expect(nextSeq).toBe(4);
      harness.port.transact((tx) => {
        tx.branch("brn-snap").table("jobs").put({
          job_id: "job-4",
          seq: nextSeq,
          kind: "daily-settle",
          due_tick: 40,
          status: "scheduled",
          idempotency_key: "daily:4",
          payload_json: {},
        });
      });
      const counts = harness.port.transact((tx) => ({
        dst: tx.branch("brn-snap").table("jobs").count(),
        src: tx.branch(SRC).table("jobs").count(),
      }));
      expect(counts).toEqual({ dst: 4, src: 3 });
    } finally {
      await harness.dispose();
    }
  });
});
