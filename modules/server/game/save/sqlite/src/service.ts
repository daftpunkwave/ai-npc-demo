/**
 * 核心职责：SQLite 存档端口实现：把在线分支复制为冻结快照，并在同一存储事务内从快照切换到后继在线分支；
 *   同时提供当前 campaign 的快照列表、恢复 dry-run 与可并入调用方事务的 InTransaction 变体。
 * 交互契约：实现 module-sdk 的 SavePort；依赖 StoragePort 的分支复制，snapshots/branches/runs/world_aliases
 *   与分支内 clock、事件表，以及宿主 ID/时间服务；不暂停时钟、不排空 job，也不校验时钟模式。
 * 约束与禁忌：暂停与排空由调用方在调用前完成；禁止覆盖已有分支、在冻结快照上继续写入、
 *   复用已存在的 run，在失败时留下部分写入，或用普通异常表示可预期的快照校验失败。
 */
import {
  DomainError,
  type ForkBranchResult,
  type HostServices,
  type IdPrefix,
  type StoragePort,
  type StorageTransaction,
} from "@world-prism/contracts";
import type {
  CreateSnapshotInput,
  RestoreInspection,
  RestoreResult,
  RestoreSnapshotInput,
  SavePort,
  SnapshotRecord,
} from "@world-prism/module-sdk";
import {
  assertExpectedSource,
  campaignBranchIds,
  inspectSnapshot,
  maxWorldSeq,
  numberValue,
  snapshotRecordOf,
  stringValue,
} from "./snapshot-read";

/** SQLite 存档实现；恢复在一次存储事务内完成分支、run、旧分支归档与在线别名切换。 */
export class SqliteSaveService implements SavePort {
  private readonly storage: StoragePort;
  private readonly host: Pick<HostServices, "ids" | "nowIso">;

  constructor(storage: StoragePort, host: Pick<HostServices, "ids" | "nowIso">) {
    this.storage = storage;
    this.host = host;
  }

  private nextId(prefix: IdPrefix): string {
    return this.host.ids(prefix);
  }

  /** 创建一致快照：复制源分支为冻结分支并写入快照行；调用方负责先暂停并排空 job。 */
  createSnapshot(input: CreateSnapshotInput): SnapshotRecord {
    return this.storage.transact((tx) => this.createSnapshotInTransaction(tx, input));
  }

  /**
   * 在调用方已开启的事务内创建快照：供宿主把运营幂等记录与冻结分支、快照行一起提交。
   * 只读写传入事务，不自行提交或回滚。
   */
  createSnapshotInTransaction(tx: StorageTransaction, input: CreateSnapshotInput): SnapshotRecord {
    if (input.label.trim().length === 0) {
      throw new DomainError("validation", "快照标签不能为空");
    }
    const source = tx.rows("branches").get({ branch_id: input.sourceBranchId });
    if (source === null) {
      throw new DomainError("not-found", `源分支 ${input.sourceBranchId} 不存在`, {
        details: { branchId: input.sourceBranchId },
      });
    }
    const clock = tx.branch(input.sourceBranchId).table("clock").get({});
    if (clock === null) {
      throw new DomainError("invalid-state", `源分支 ${input.sourceBranchId} 缺少时钟记录`, {
        details: { branchId: input.sourceBranchId },
      });
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
      worldTick: numberValue(clock["world_tick"], "clock.world_tick"),
      label: input.label,
      createdBy: input.createdBy,
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
  }

  /** 只列出当前 campaign（在线别名分支及其父链）创建的存档；其他分支或 campaign 的快照不出现。 */
  listSnapshots(): readonly SnapshotRecord[] {
    return this.storage.transact((tx) => {
      const campaign = campaignBranchIds(tx);
      if (campaign.size === 0) {
        return [];
      }
      return tx
        .rows("snapshots")
        .list()
        .map((row) => snapshotRecordOf(row))
        .filter((record) => campaign.has(record.sourceBranchId));
    });
  }

  /** 恢复 dry-run：只读校验快照完整性与源 run 记录；失败不产生任何写入。 */
  inspectRestore(snapshotId: string): RestoreInspection {
    return this.storage.transact((tx) => this.inspectRestoreInTransaction(tx, snapshotId));
  }

  /** 在调用方事务内执行恢复 dry-run；只读传入事务，不自行提交。 */
  inspectRestoreInTransaction(tx: StorageTransaction, snapshotId: string): RestoreInspection {
    return inspectSnapshot(tx, snapshotId);
  }

  /**
   * 在调用方已开启的事务内从快照切换在线世界：创建后继分支与绑定源 RunSpec 的新 run、结束旧 run、
   * 归档旧分支，并原子切换 world_aliases('online')；任一步失败由调用方事务整体回滚，旧分支与别名保持原状。
   * 只读写传入事务，不自行提交或回滚。
   */
  restoreSnapshotInTransaction(tx: StorageTransaction, input: RestoreSnapshotInput): RestoreResult {
    const inspection = inspectSnapshot(tx, input.snapshotId);
    if (input.expected !== undefined) {
      assertExpectedSource(input.expected, inspection);
    }

    const alias = tx.rows("world_aliases").get({ alias: "online" });
    if (alias === null) {
      throw new DomainError("invalid-state", "没有 world_aliases('online')，拒绝恢复");
    }
    const previousBranchId = stringValue(alias["branch_id"], "world_aliases.branch_id");
    const previousBranch = tx.rows("branches").get({ branch_id: previousBranchId });
    if (previousBranch === null) {
      throw new DomainError("invalid-state", `在线别名指向的分支 ${previousBranchId} 不存在`);
    }
    if (previousBranch["kind"] !== "online") {
      throw new DomainError("invalid-state", `在线别名指向的分支 ${previousBranchId} 不是 online 分支`);
    }
    const previousStatus = stringValue(previousBranch["status"], "branches.status");
    if (previousStatus !== "active" && previousStatus !== "paused") {
      throw new DomainError("invalid-state", `在线别名指向的分支 ${previousBranchId} 状态为 ${previousStatus}，拒绝恢复`);
    }
    if (previousBranch["world_id"] !== inspection.worldId) {
      throw new DomainError("invalid-state", "快照与当前在线世界不属于同一 campaign，拒绝恢复");
    }
    const previousRunId = typeof previousBranch["run_id"] === "string" ? previousBranch["run_id"] : "";
    if (previousRunId.length === 0) {
      throw new DomainError("invalid-state", `在线分支 ${previousBranchId} 没有绑定 run，拒绝恢复`);
    }
    const previousRun = tx.rows("runs").get({ run_id: previousRunId });
    if (previousRun === null) {
      throw new DomainError("invalid-state", `在线 run ${previousRunId} 不存在，拒绝恢复`);
    }

    const runId = input.runId ?? this.nextId("run");
    if (runId.trim().length === 0) {
      throw new DomainError("validation", "后继 run ID 不能为空");
    }
    if (runId === previousRunId || tx.rows("runs").get({ run_id: runId }) !== null) {
      throw new DomainError("invalid-state", `run ${runId} 已存在，拒绝复用为后继 run`);
    }

    const now = this.host.nowIso();
    // 分支复制会整表复制待办 job，并把后继时钟置为 paused、递增控制 epoch。
    const fork = this.storage.forkBranch(tx, {
      srcBranchId: inspection.frozenBranchId,
      dstBranchId: this.nextId("br"),
      kind: "online",
      runId,
    });
    tx.rows("runs").put({
      run_id: runId,
      world_id: inspection.worldId,
      branch_id: fork.branchId,
      mode: "live",
      status: "running",
      run_spec_json: inspection.sourceRun.runSpec,
      manifest_json: inspection.sourceRun.manifest,
      manifest_hash: inspection.sourceRun.manifestHash,
      contaminated: inspection.sourceRun.contaminated,
      evidence_complete: inspection.sourceRun.evidenceComplete,
      created_at: now,
      started_at: now,
      ended_at: null,
    });
    tx.rows("runs").put({
      ...previousRun,
      status: "completed",
      ended_at: typeof previousRun["ended_at"] === "string" ? previousRun["ended_at"] : now,
    });
    tx.rows("branches").put({ ...previousBranch, status: "archived" });
    tx.rows("world_aliases").put({ alias: "online", branch_id: fork.branchId, updated_at: now });
    return {
      branchId: fork.branchId,
      runId,
      worldId: inspection.worldId,
      previousBranchId,
      sourceRunId: inspection.sourceRun.runId,
      worldSeq: inspection.worldSeq,
      worldTick: inspection.worldTick,
    };
  }
}
