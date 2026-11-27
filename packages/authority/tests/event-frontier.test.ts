/**
 * 核心职责：验证分支事件前沿查询的取值规则：无事件记 0，合法序号原样返回，损坏序号按 invalid-state 拒绝。
 * 交互契约：使用只实现分支表 max 的事务桩，记录被查询的分支、表与列；不打开 SQLite。
 * 约束与禁忌：不断言查询以外的存储行为，也不允许把损坏序号兜底成 0。
 */
import { describe, expect, it } from "vitest";
import { DomainError, type StorageTransaction, type StorageValue } from "@world-prism/contracts";
import { branchEventFrontier } from "../src/event-queries";

interface MaxCall {
  readonly branchId: string;
  readonly table: string;
  readonly column: string;
}

/** 只支持 branch(id).table(name).max(column) 的事务桩；其余访问说明查询越界，直接失败。 */
function transactionReturning(value: StorageValue, calls: MaxCall[]): StorageTransaction {
  const unsupported = (): never => {
    throw new Error("事件前沿查询不应访问 max 以外的存储接口");
  };
  return {
    get: unsupported,
    all: unsupported,
    run: unsupported,
    rows: unsupported,
    savepoint: unsupported,
    branch: (branchId: string) => ({
      branchId,
      table: (table: string) => ({
        table,
        get: unsupported,
        list: unsupported,
        put: unsupported,
        delete: unsupported,
        count: unsupported,
        max: (column: string) => {
          calls.push({ branchId, table, column });
          return value;
        },
      }),
    }),
  };
}

function frontierError(value: StorageValue): DomainError {
  let caught: unknown;
  try {
    branchEventFrontier(transactionReturning(value, []), "br-000000000001");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  return caught as DomainError;
}

describe("分支事件前沿", () => {
  it("按分支读取 domain_events 的最大 world_seq", () => {
    const calls: MaxCall[] = [];
    expect(branchEventFrontier(transactionReturning(42, calls), "br-000000000001")).toBe(42);
    expect(calls).toEqual([{ branchId: "br-000000000001", table: "domain_events", column: "world_seq" }]);
  });

  it("没有任何事件的分支前沿为 0", () => {
    expect(branchEventFrontier(transactionReturning(null, []), "br-000000000001")).toBe(0);
  });

  it("负数、非整数与非数值序号按 invalid-state 拒绝并带出分支", () => {
    for (const value of [-1, 1.5, "7", 7n]) {
      const error = frontierError(value);
      expect(error.code).toBe("invalid-state");
      expect(error.safeMessage).toContain("事件前沿");
      expect(error.details).toEqual({ branchId: "br-000000000001" });
    }
  });
});
