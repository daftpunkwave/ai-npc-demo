/**
 * 读取分支注册行与时钟行，供命令网关、job、消费者和时钟步骤共享。
 * 依赖存储端口、分支/时钟 schema 值与行读取辅助；不修改时钟或分支状态。
 * 禁止把缺失时钟当作可继续执行，也禁止接受未知分支类型或时钟模式。
 */
import {
  DomainError,
  branchKindSchema,
  branchStatusSchema,
  type BranchKind,
  type BranchStatus,
  type StorageTransaction,
} from "@world-prism/contracts";
import {
  optionalStorageNumber,
  optionalStorageString,
  requireStorageNumber,
  requireStorageString,
} from "./storage-values";

/** 时钟模式：只有 running 与 stepping 接受普通世界命令。 */
export const clockModes = ["running", "pausing", "paused", "resuming", "stepping"] as const;

export type ClockMode = (typeof clockModes)[number];

/** 分支注册行的关键字段；worldId 用于校验认证上下文。 */
export interface BranchRecord {
  readonly branchId: string;
  readonly worldId: string;
  readonly kind: BranchKind;
  readonly status: BranchStatus;
  readonly runId: string | null;
  readonly profileHash: string | null;
}

/** 分支时钟的关键字段；worldTick 是事务内世界时间。 */
export interface ClockRecord {
  readonly worldTick: number;
  readonly mode: ClockMode;
  readonly runVersion: number;
}

/** 读取分支注册行；不存在返回 null，存在但字段非法时抛错。 */
export function readBranch(tx: StorageTransaction, branchId: string): BranchRecord | null {
  const row = tx.rows("branches").get({ branch_id: branchId });
  if (row === null) {
    return null;
  }
  const kind = branchKindSchema.safeParse(requireStorageString(row, "branches", "kind"));
  if (!kind.success) {
    throw new DomainError("invalid-state", `分支 ${branchId} 的类型不在登记集合内`, {
      details: { branchId },
    });
  }
  const status = branchStatusSchema.safeParse(requireStorageString(row, "branches", "status"));
  if (!status.success) {
    throw new DomainError("invalid-state", `分支 ${branchId} 的状态不在登记集合内`, {
      details: { branchId },
    });
  }
  return {
    branchId,
    worldId: requireStorageString(row, "branches", "world_id"),
    kind: kind.data,
    status: status.data,
    runId: optionalStorageString(row, "branches", "run_id"),
    profileHash: optionalStorageString(row, "branches", "profile_hash"),
  };
}

function parseClockMode(value: string, branchId: string): ClockMode {
  const mode = clockModes.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new DomainError("invalid-state", `分支 ${branchId} 的时钟模式不在登记集合内`, {
      details: { branchId, mode: value },
    });
  }
  return mode;
}

/** 读取分支时钟；缺失时明确 not-ready，避免在未知世界时间提交命令。 */
export function readClock(tx: StorageTransaction, branchId: string): ClockRecord {
  const row = tx.branch(branchId).table("clock").get({});
  if (row === null) {
    throw new DomainError("not-ready", `分支 ${branchId} 尚未建立时钟状态`, {
      details: { branchId },
    });
  }
  return {
    worldTick: requireStorageNumber(row, "clock", "world_tick"),
    mode: parseClockMode(requireStorageString(row, "clock", "mode"), branchId),
    runVersion: requireStorageNumber(row, "clock", "run_version"),
  };
}

/** 尝试读取时钟；仅幂等冲突回执等无法开启世界写入的路径使用。 */
export function tryReadClock(tx: StorageTransaction, branchId: string): ClockRecord | null {
  const row = tx.branch(branchId).table("clock").get({});
  if (row === null) {
    return null;
  }
  return {
    worldTick: requireStorageNumber(row, "clock", "world_tick"),
    mode: parseClockMode(requireStorageString(row, "clock", "mode"), branchId),
    runVersion: optionalStorageNumber(row, "clock", "run_version") ?? 0,
  };
}
