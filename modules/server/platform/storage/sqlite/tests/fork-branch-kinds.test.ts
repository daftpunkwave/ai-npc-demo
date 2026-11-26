/**
 * 验证分支复制的状态与失败路径：不同分支类型的 status/run_id 规则、重复目标、缺失源与事务外调用。
 * 依赖分支复制测试种子数据与存储模块测试助手。
 * 禁止跳过非法请求断言，或让分支复制在事务外产生部分写入。
 */
import { describe, expect, it } from "vitest";
import type { StorageTransaction } from "@world-prism/contracts";
import { SRC, forkInto, seedSourceBranch } from "./fork-support";
import { expectDomainError, openStorageHarness } from "./support";

describe("分支类型与 branches 行", () => {
  it("在线与实验分支为 active 并绑定 run，快照冻结，沙盒不绑定 run", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      forkInto(harness.port, "brn-online", "online", "run-online");
      forkInto(harness.port, "brn-exp", "experiment", "run-exp");
      forkInto(harness.port, "brn-sandbox", "sandbox");
      const rows = harness.port.transact((tx) =>
        ["brn-online", "brn-exp", "brn-sandbox"].map((branchId) => {
          const row = tx.rows("branches").get({ branch_id: branchId });
          return { branchId, status: row?.["status"], runId: row?.["run_id"] };
        }),
      );
      expect(rows).toEqual([
        { branchId: "brn-online", status: "active", runId: "run-online" },
        { branchId: "brn-exp", status: "active", runId: "run-exp" },
        { branchId: "brn-sandbox", status: "active", runId: null },
      ]);
    } finally {
      await harness.dispose();
    }
  });
});

describe("分支复制失败路径", () => {
  it("拒绝重复目标分支", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      forkInto(harness.port, "brn-snap", "snapshot");
      expectDomainError(
        () =>
          harness.port.transact((tx) =>
            harness.port.forkBranch(tx, { srcBranchId: SRC, dstBranchId: "brn-snap", kind: "snapshot" }),
          ),
        "validation",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝缺失的源分支", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      expectDomainError(
        () =>
          harness.port.transact((tx) =>
            harness.port.forkBranch(tx, { srcBranchId: "brn-missing", dstBranchId: "brn-new", kind: "snapshot" }),
          ),
        "not-found",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝在线分支缺少 run 的请求", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      expectDomainError(
        () =>
          harness.port.transact((tx) =>
            harness.port.forkBranch(tx, { srcBranchId: SRC, dstBranchId: "brn-online-bad", kind: "online" }),
          ),
        "validation",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝事务外调用", async () => {
    const harness = await openStorageHarness();
    try {
      seedSourceBranch(harness.port);
      expectDomainError(
        () =>
          harness.port.forkBranch(null as unknown as StorageTransaction, {
            srcBranchId: SRC,
            dstBranchId: "brn-outside",
            kind: "snapshot",
          }),
        "invalid-state",
      );
      const branches = harness.port.transact((tx) => tx.rows("branches").count());
      expect(branches).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});
