/**
 * 存档服务：把在线分支复制为冻结快照，并从快照创建后继在线分支。
 * 依赖 SQLite StoragePort、分支复制与快照表；不自行暂停时钟或排空 job。
 * 禁止在未暂停/静默时保存，也禁止覆盖已有分支或在快照上继续写入。
 */
import type {
  BranchKind,
  ForkBranchResult,
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

export interface SaveService {
  createSnapshot(input: CreateSnapshotInput): SnapshotRecord;
  listSnapshots(): readonly SnapshotRecord[];
  restoreSnapshot(input: RestoreSnapshotInput): { readonly branchId: string; readonly runId: string };
}

function numberCell(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`snapshots.${column} 不是安全整数`);
  }
  return value;
}

function stringCell(row: Record<string, unknown>, column: string): string {
  const value = row[column];
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
export class SqliteSaveService implements SaveService {
  private readonly storage: StoragePort;
  private readonly ids: (prefix: string) => string;
  private readonly nowIso: () => string;

  constructor(storage: StoragePort, ids: (prefix: string) => string, nowIso: () => string) {
    this.storage = storage;
    this.ids = ids;
    this.nowIso = nowIso;
  }

  createSnapshot(input: CreateSnapshotInput): SnapshotRecord {
    return this.storage.transact((tx) => {
      const source = tx.rows("branches").get({ branch_id: input.sourceBranchId });
      if (source === null) {
        throw new Error(`源分支 ${input.sourceBranchId} 不存在`);
      }
      const snapshotId = this.ids("snap");
      const frozenBranchId = this.ids("br");
      const fork: ForkBranchResult = this.storage.forkBranch(tx, {
        srcBranchId: input.sourceBranchId,
        dstBranchId: frozenBranchId,
        kind: "snapshot",
      });
      const clock = tx.branch(input.sourceBranchId).table("clock").get({});
      const worldTick = clock === null ? 0 : numberCell(clock, "world_tick");
      const record: SnapshotRecord = {
        snapshotId,
        sourceBranchId: input.sourceBranchId,
        frozenBranchId: fork.branchId,
        worldSeq: maxWorldSeq(tx, input.sourceBranchId),
        worldTick,
        label: input.label,
        createdAt: this.nowIso(),
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
        snapshotId: stringCell(row, "snapshot_id"),
        sourceBranchId: stringCell(row, "source_branch_id"),
        frozenBranchId: stringCell(row, "frozen_branch_id"),
        worldSeq: numberCell(row, "world_seq"),
        worldTick: numberCell(row, "world_tick"),
        label: stringCell(row, "label"),
        createdAt: stringCell(row, "created_at"),
      })),
    );
  }

  restoreSnapshot(input: RestoreSnapshotInput): { readonly branchId: string; readonly runId: string } {
    return this.storage.transact((tx) => {
      const row = tx.rows("snapshots").get({ snapshot_id: input.snapshotId });
      if (row === null) {
        throw new Error(`快照 ${input.snapshotId} 不存在`);
      }
      const sourceBranchId = stringCell(row, "source_branch_id");
      const source = tx.rows("branches").get({ branch_id: sourceBranchId });
      if (source === null) {
        throw new Error(`快照源分支 ${sourceBranchId} 不存在`);
      }
      const runId = input.runId ?? this.ids("run");
      const branchId = this.ids("br");
      const fork: ForkBranchResult = this.storage.forkBranch(tx, {
        srcBranchId: stringCell(row, "frozen_branch_id"),
        dstBranchId: branchId,
        kind: "online" as BranchKind,
        runId,
      });
      return { branchId: fork.branchId, runId };
    });
  }
}
