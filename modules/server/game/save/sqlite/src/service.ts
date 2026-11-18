/**
 * 存档服务：把在线分支复制为冻结快照，并从快照创建后继在线分支。
 * 依赖 SQLite StoragePort、分支复制与快照表；不自行暂停时钟或排空 job。
 * 禁止在未暂停/静默时保存，也禁止覆盖已有分支或在快照上继续写入。
 */
/* eslint-disable security/detect-object-injection -- 行访问只使用本文件固定的 snapshots 列名。 */
import type {
  BranchKind,
  ForkBranchResult,
  HostServices,
  StoragePort,
  StorageTransaction,
} from "@ai-npc/contracts";

export interface SnapshotRecord {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly label: string;
  readonly createdAt: string;
}

export interface CreateSnapshotInput {
  readonly sourceBranchId: string;
  readonly label: string;
  readonly createdBy: string;
}

export interface RestoreSnapshotInput {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
}

function numberValue(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`snapshots.${column} 不是安全整数`);
  }
  return value;
}

function stringValue(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`snapshots.${column} 不是非空字符串`);
  }
  return value;
}

function maxWorldSeq(tx: StorageTransaction, branchId: string): number {
  let max = 0;
  for (const row of tx.branch(branchId).table("domain_events").list()) {
    const value = row["world_seq"];
    if (typeof value === "number" && value > max) {
      max = value;
    }
  }
  return max;
}

/** SQLite 存档实现；所有操作在单个存储事务内完成分支复制与快照行写入。 */
export class SqliteSaveService {
  private readonly storage: StoragePort;
  private readonly host: Pick<HostServices, "ids" | "nowIso">;

  constructor(storage: StoragePort, host: Pick<HostServices, "ids" | "nowIso">) {
    this.storage = storage;
    this.host = host;
  }

  private nextId(prefix: string): string {
    return this.host.ids(prefix);
  }

  createSnapshot(input: CreateSnapshotInput): SnapshotRecord {
    if (input.label.trim().length === 0) {
      throw new Error("快照标签不能为空");
    }
    return this.storage.transact((tx) => {
      const source = tx.rows("branches").get({ branch_id: input.sourceBranchId });
      if (source === null) {
        throw new Error(`源分支 ${input.sourceBranchId} 不存在`);
      }
      const clock = tx.branch(input.sourceBranchId).table("clock").get({});
      if (clock === null) {
        throw new Error(`源分支 ${input.sourceBranchId} 缺少时钟记录`);
      }
      const snapshotId = this.nextId("snap");
      const frozenBranchId = this.nextId("br");
      const fork: ForkBranchResult = this.storage.forkBranch(tx, {
        srcBranchId: input.sourceBranchId,
        dstBranchId: frozenBranchId,
        kind: "snapshot",
      });
      const record: SnapshotRecord = {
        snapshotId,
        sourceBranchId: input.sourceBranchId,
        frozenBranchId: fork.branchId,
        worldSeq: maxWorldSeq(tx, input.sourceBranchId),
        worldTick: numberValue(clock["world_tick"], "world_tick"),
        label: input.label,
        createdAt: this.host.nowIso(),
      };
      tx.rows("snapshots").put({
        snapshot_id: record.snapshotId,
        source_branch_id: record.sourceBranchId,
        frozen_branch_id: record.frozenBranchId,
        world_seq: record.worldSeq,
        world_tick: record.worldTick,
        label: record.label,
        manifest_hash: null,
        created_by: input.createdBy,
        created_at: record.createdAt,
      });
      return record;
    });
  }

  listSnapshots(): readonly SnapshotRecord[] {
    return this.storage.transact((tx) =>
      tx.rows("snapshots").list().map((row) => ({
        snapshotId: stringValue(row["snapshot_id"], "snapshot_id"),
        sourceBranchId: stringValue(row["source_branch_id"], "source_branch_id"),
        frozenBranchId: stringValue(row["frozen_branch_id"], "frozen_branch_id"),
        worldSeq: numberValue(row["world_seq"], "world_seq"),
        worldTick: numberValue(row["world_tick"], "world_tick"),
        label: stringValue(row["label"], "label"),
        createdAt: stringValue(row["created_at"], "created_at"),
      })),
    );
  }

  restoreSnapshot(input: RestoreSnapshotInput): { readonly branchId: string; readonly runId: string } {
    return this.storage.transact((tx) => {
      const row = tx.rows("snapshots").get({ snapshot_id: input.snapshotId });
      if (row === null) {
        throw new Error(`快照 ${input.snapshotId} 不存在`);
      }
      const sourceBranchId = stringValue(row["source_branch_id"], "source_branch_id");
      const frozenBranchId = stringValue(row["frozen_branch_id"], "frozen_branch_id");
      const source = tx.rows("branches").get({ branch_id: sourceBranchId });
      if (source === null) {
        throw new Error(`快照源分支 ${sourceBranchId} 不存在`);
      }
      const frozen = tx.rows("branches").get({ branch_id: frozenBranchId });
      if (frozen === null || frozen["kind"] !== "snapshot" || frozen["status"] !== "frozen" || frozen["run_id"] !== null) {
        throw new Error("快照冻结分支状态不合法");
      }
      const runId = input.runId ?? this.nextId("run");
      const branchId = this.nextId("br");
      const fork: ForkBranchResult = this.storage.forkBranch(tx, {
        srcBranchId: frozenBranchId,
        dstBranchId: branchId,
        kind: "online" as BranchKind,
        runId,
      });
      return { branchId: fork.branchId, runId };
    });
  }
}

/** 存档服务公开类型；调用方只依赖这些方法。 */
export type SaveService = Pick<SqliteSaveService, "createSnapshot" | "listSnapshots" | "restoreSnapshot">;
