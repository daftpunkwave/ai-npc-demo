/**
 * 验证存储端口相关 schema 的严格解析：分支类型、复制请求与备份选项。
 * 依赖公共契约包的 storage 主题导出与共享断言助手。
 * 禁止在此打开数据库或验证适配器行为；适配器行为由模块自身测试覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  backupOptionsSchema,
  branchKindSchema,
  branchStatusSchema,
  forkBranchRequestSchema,
} from "../src/index";
import { expectInvalid, expectRejectsUnknownKey, expectValid } from "./support";

describe("分支枚举", () => {
  it("分支类型固定四种", () => {
    for (const value of ["online", "experiment", "snapshot", "sandbox"]) {
      expectValid(branchKindSchema, value);
    }
    expectInvalid(branchKindSchema, "live");
    expectInvalid(branchKindSchema, "");
  });

  it("分支状态固定四种", () => {
    for (const value of ["active", "paused", "frozen", "archived"]) {
      expectValid(branchStatusSchema, value);
    }
    expectInvalid(branchStatusSchema, "running");
  });
});

describe("分支复制请求", () => {
  it("在线世界与实验分支必须绑定 run", () => {
    const online = { srcBranchId: "brn-src", dstBranchId: "brn-dst", kind: "online", runId: "run-1" };
    expectValid(forkBranchRequestSchema, online);
    expectInvalid(forkBranchRequestSchema, { ...online, runId: undefined });
    expectInvalid(forkBranchRequestSchema, { ...online, runId: null });

    const experiment = { srcBranchId: "brn-src", dstBranchId: "brn-dst", kind: "experiment", runId: "run-2" };
    expectValid(forkBranchRequestSchema, experiment);
    expectInvalid(forkBranchRequestSchema, { ...experiment, runId: undefined });
  });

  it("快照与沙盒分支不能绑定 run", () => {
    const snapshot = { srcBranchId: "brn-src", dstBranchId: "brn-dst", kind: "snapshot" };
    expectValid(forkBranchRequestSchema, snapshot);
    expectValid(forkBranchRequestSchema, { ...snapshot, runId: null });
    expectInvalid(forkBranchRequestSchema, { ...snapshot, runId: "run-1" });

    const sandbox = { srcBranchId: "brn-src", dstBranchId: "brn-dst", kind: "sandbox", profileHash: "hash-1" };
    expectValid(forkBranchRequestSchema, sandbox);
    expectInvalid(forkBranchRequestSchema, { ...sandbox, runId: "run-1" });
  });

  it("拒绝空 ID 与未知键", () => {
    const valid = { srcBranchId: "brn-src", dstBranchId: "brn-dst", kind: "snapshot" };
    expectInvalid(forkBranchRequestSchema, { ...valid, srcBranchId: "" });
    expectInvalid(forkBranchRequestSchema, { ...valid, dstBranchId: "" });
    expectInvalid(forkBranchRequestSchema, { ...valid, kind: 7 });
    expectRejectsUnknownKey(forkBranchRequestSchema, valid);
  });
});

describe("备份选项", () => {
  it("省略标签与合法标签都通过", () => {
    expectValid(backupOptionsSchema, {});
    expectValid(backupOptionsSchema, { label: "nightly-1" });
  });

  it("标签不能包含路径片段或大小写", () => {
    expectInvalid(backupOptionsSchema, { label: "../evil" });
    expectInvalid(backupOptionsSchema, { label: "Nightly" });
    expectInvalid(backupOptionsSchema, { label: "a".repeat(33) });
    expectInvalid(backupOptionsSchema, { label: "" });
    expectRejectsUnknownKey(backupOptionsSchema, { label: "ok" });
  });

  it("备份 schema 不声明额外字段", () => {
    expect(Object.keys(backupOptionsSchema.shape)).toEqual(["label"]);
  });
});
