/**
 * 核心职责：从存储只读地取出快照与源 run 的冻结事实，并校验恢复前提。
 * 交互契约：输入存储事务与快照标识，返回强类型视图；数据不一致时抛出 invalid-state 并给出字段。
 * 约束与禁忌：不写存储、不做业务裁决，也不在字段缺失时用默认值兜底。
 */
import { DomainError, canonicalJson, type Json, type StorageCell, type StorageTransaction, type StorageRow } from "@world-prism/contracts";
import type {
  FrozenSnapshot,
  RestoreExpectation,
  RestoreInspection,
  SnapshotRecord,
  SnapshotSourceRun,
} from "./snapshot-types";

export function numberValue(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DomainError("invalid-state", `快照数据字段 ${column} 不是安全整数`, { details: { column } });
  }
  return value;
}

export function stringValue(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("invalid-state", `快照数据字段 ${column} 不是非空字符串`, { details: { column } });
  }
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
export function objectValue(value: StorageCell | undefined, column: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    throw new DomainError("invalid-state", `快照数据字段 ${column} 不是 JSON 对象`, { details: { column } });
  }
  return value as Json;
}

/** 分支事件前沿：domain_events 主键为 (branch_id, world_seq)，MAX 走主键索引而非全表遍历。 */
export function maxWorldSeq(tx: StorageTransaction, branchId: string): number {
  const value = tx.branch(branchId).table("domain_events").max("world_seq");
  if (value === null) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("invalid-state", "分支事件前沿不是非负安全整数", { details: { branchId } });
  }
  return value;
}

/**
 * 校验快照行、冻结分支与源分支属于同一份一致复制：冻结分支必须仍处于 frozen 且无 run，
 * 时钟 tick 与快照记录一致，事件前沿等于快照的 world_seq；任何缺失都视为快照不完整。
 */
export function readFrozenSnapshot(tx: StorageTransaction, snapshotId: string): FrozenSnapshot {
  const row = tx.rows("snapshots").get({ snapshot_id: snapshotId });
  if (row === null) {
    throw new DomainError("not-found", `快照 ${snapshotId} 不存在`, { details: { snapshotId } });
  }
  const sourceBranchId = stringValue(row["source_branch_id"], "snapshots.source_branch_id");
  const frozenBranchId = stringValue(row["frozen_branch_id"], "snapshots.frozen_branch_id");
  const worldSeq = numberValue(row["world_seq"], "snapshots.world_seq");
  const worldTick = numberValue(row["world_tick"], "snapshots.world_tick");

  const sourceBranch = tx.rows("branches").get({ branch_id: sourceBranchId });
  if (sourceBranch === null) {
    throw new DomainError("not-found", `快照源分支 ${sourceBranchId} 不存在`, {
      details: { sourceBranchId },
    });
  }
  if (sourceBranch["kind"] !== "online") {
    throw new DomainError("invalid-state", `快照源分支 ${sourceBranchId} 不是 online 分支，无法作为在线恢复来源`, {
      details: { sourceBranchId },
    });
  }
  const worldId = stringValue(sourceBranch["world_id"], "branches.world_id");

  const frozen = tx.rows("branches").get({ branch_id: frozenBranchId });
  if (frozen === null) {
    throw new DomainError("not-found", `快照冻结分支 ${frozenBranchId} 不存在`, {
      details: { snapshotId, frozenBranchId },
    });
  }
  if (frozen["kind"] !== "snapshot" || frozen["status"] !== "frozen" || frozen["run_id"] !== null) {
    throw new DomainError("invalid-state", "快照冻结分支状态不合法", {
      details: {
        snapshotId,
        frozenBranchId,
        kind: typeof frozen["kind"] === "string" ? frozen["kind"] : null,
        status: typeof frozen["status"] === "string" ? frozen["status"] : null,
      },
    });
  }
  if (frozen["world_id"] !== worldId) {
    throw new DomainError("invalid-state", "快照冻结分支与源分支不属于同一 world", {
      details: { snapshotId, frozenBranchId, sourceBranchId },
    });
  }
  if (frozen["parent_branch_id"] !== sourceBranchId) {
    throw new DomainError("invalid-state", "快照冻结分支的父分支与快照源分支不一致", {
      details: { snapshotId, frozenBranchId, sourceBranchId },
    });
  }

  const clock = tx.branch(frozenBranchId).table("clock").get({});
  if (clock === null) {
    throw new DomainError("invalid-state", `快照冻结分支 ${frozenBranchId} 缺少时钟记录`, {
      details: { snapshotId, frozenBranchId },
    });
  }
  if (numberValue(clock["world_tick"], "clock.world_tick") !== worldTick) {
    throw new DomainError("invalid-state", `快照 ${snapshotId} 的 worldTick 与冻结分支时钟不一致`, {
      details: { snapshotId, frozenBranchId, worldTick },
    });
  }
  if (maxWorldSeq(tx, frozenBranchId) !== worldSeq) {
    throw new DomainError("invalid-state", `快照 ${snapshotId} 的 worldSeq 与冻结分支事件前沿不一致`, {
      details: { snapshotId, frozenBranchId, worldSeq },
    });
  }

  const sourceRunId = typeof sourceBranch["run_id"] === "string" && sourceBranch["run_id"].length > 0
    ? sourceBranch["run_id"]
    : null;
  return { snapshotId, sourceBranchId, frozenBranchId, worldId, worldSeq, worldTick, sourceRunId };
}

/** 读取源分支已冻结的 run；恢复沿用它的 RunSpec、seed 与 manifest，不再按当前入参重建。 */
export function readSourceRun(tx: StorageTransaction, frozen: FrozenSnapshot): SnapshotSourceRun {
  if (frozen.sourceRunId === null) {
    throw new DomainError("invalid-state", `快照源分支 ${frozen.sourceBranchId} 没有绑定 run，无法沿用运行规格`, {
      details: { snapshotId: frozen.snapshotId, sourceBranchId: frozen.sourceBranchId },
    });
  }
  const run = tx.rows("runs").get({ run_id: frozen.sourceRunId });
  if (run === null) {
    throw new DomainError("not-found", `快照源 run ${frozen.sourceRunId} 不存在`, {
      details: { runId: frozen.sourceRunId },
    });
  }
  if (run["world_id"] !== frozen.worldId) {
    throw new DomainError("invalid-state", `快照源 run ${frozen.sourceRunId} 与快照不属于同一 world`, {
      details: { runId: frozen.sourceRunId, worldId: frozen.worldId },
    });
  }
  if (run["branch_id"] !== frozen.sourceBranchId) {
    throw new DomainError("invalid-state", `快照源 run ${frozen.sourceRunId} 绑定的分支与快照源分支不一致`, {
      details: { runId: frozen.sourceRunId, sourceBranchId: frozen.sourceBranchId },
    });
  }
  return {
    runId: frozen.sourceRunId,
    worldId: frozen.worldId,
    branchId: frozen.sourceBranchId,
    runSpec: objectValue(run["run_spec_json"], "runs.run_spec_json"),
    manifest: objectValue(run["manifest_json"], "runs.manifest_json"),
    manifestHash: stringValue(run["manifest_hash"], "runs.manifest_hash"),
    contaminated: numberValue(run["contaminated"], "runs.contaminated"),
    evidenceComplete: numberValue(run["evidence_complete"], "runs.evidence_complete"),
  };
}

/** 从快照行一路读出完整恢复信息；快照与源 run 任一不完整都抛错，不产生写入。 */
export function inspectSnapshot(tx: StorageTransaction, snapshotId: string): RestoreInspection {
  const frozen = readFrozenSnapshot(tx, snapshotId);
  return {
    snapshotId: frozen.snapshotId,
    sourceBranchId: frozen.sourceBranchId,
    frozenBranchId: frozen.frozenBranchId,
    worldId: frozen.worldId,
    worldSeq: frozen.worldSeq,
    worldTick: frozen.worldTick,
    sourceRun: readSourceRun(tx, frozen),
  };
}

export function assertExpectedSource(expected: RestoreExpectation, inspection: RestoreInspection): void {
  const matches =
    expected.sourceRunId === inspection.sourceRun.runId &&
    expected.manifestHash === inspection.sourceRun.manifestHash &&
    expected.canonicalRunSpec === canonicalJson(inspection.sourceRun.runSpec) &&
    expected.worldSeq === inspection.worldSeq &&
    expected.worldTick === inspection.worldTick;
  if (!matches) {
    throw new DomainError("invalid-state", "快照源 run 在 dry-run 后被修改，拒绝按旧校验结果恢复", {
      details: { snapshotId: inspection.snapshotId, sourceRunId: inspection.sourceRun.runId },
    });
  }
}

/**
 * 当前 campaign 的在线分支集合：从在线别名分支沿 parent_branch_id 向上追溯，
 * 只收集链上的 online 分支（跨越恢复产生的冻结分支）；其他 campaign、实验与沙盒分支不在链上。
 */
export function campaignBranchIds(tx: StorageTransaction): ReadonlySet<string> {
  const alias = tx.rows("world_aliases").get({ alias: "online" });
  if (alias === null) {
    return new Set();
  }
  const onlineBranchId = typeof alias["branch_id"] === "string" ? alias["branch_id"] : "";
  if (onlineBranchId.length === 0) {
    return new Set();
  }
  const seen = new Set<string>();
  const online = new Set<string>();
  let current: string | null = onlineBranchId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const branch = tx.rows("branches").get({ branch_id: current });
    if (branch === null) {
      break;
    }
    if (branch["kind"] === "online") {
      online.add(current);
    }
    const parent = branch["parent_branch_id"];
    current = typeof parent === "string" && parent.length > 0 ? parent : null;
  }
  return online;
}

export function snapshotRecordOf(row: StorageRow): SnapshotRecord {
  return {
    snapshotId: stringValue(row["snapshot_id"], "snapshots.snapshot_id"),
    sourceBranchId: stringValue(row["source_branch_id"], "snapshots.source_branch_id"),
    frozenBranchId: stringValue(row["frozen_branch_id"], "snapshots.frozen_branch_id"),
    worldSeq: numberValue(row["world_seq"], "snapshots.world_seq"),
    worldTick: numberValue(row["world_tick"], "snapshots.world_tick"),
    label: stringValue(row["label"], "snapshots.label"),
    createdBy: stringValue(row["created_by"], "snapshots.created_by"),
    createdAt: stringValue(row["created_at"], "snapshots.created_at"),
  };
}
