/**
 * 存档服务：把在线分支复制为冻结快照，并在同一存储事务内从快照切换到后继在线分支；
 * 同时提供当前 campaign 的快照列表、恢复 dry-run 与可并入调用方事务的 InTransaction 变体。
 * 依赖 StoragePort 的分支复制，snapshots/branches/runs/world_aliases 与分支内 clock、事件表，
 * 以及宿主 ID/时间服务；不暂停时钟、不排空 job，也不校验时钟模式。
 * 暂停与排空由调用方在调用前完成；禁止覆盖已有分支、在冻结快照上继续写入、
 * 复用已存在的 run，或在失败时留下部分写入。
 */
import {
  DomainError,
  canonicalJson,
  type ForkBranchResult,
  type HostServices,
  type Json,
  type StorageCell,
  type StoragePort,
  type StorageRow,
  type StorageTransaction,
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

/** 恢复 dry-run 读出的源 run；宿主据它校验内容、装配、名册与运行规格兼容性。 */
export interface SnapshotSourceRun {
  readonly runId: string;
  readonly worldId: string;
  readonly branchId: string;
  readonly runSpec: Json;
  readonly manifest: Json;
  readonly manifestHash: string;
  readonly contaminated: number;
  readonly evidenceComplete: number;
}

/** 一次恢复 dry-run 的结果；只做只读校验，不产生任何写入。 */
export interface RestoreInspection {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly sourceRun: SnapshotSourceRun;
}

/** dry-run 与提交之间源 run 的稳定摘要；事务内重新比对，防止校验后被并发改写。 */
export interface RestoreExpectation {
  readonly sourceRunId: string;
  readonly canonicalRunSpec: string;
  readonly manifestHash: string;
  readonly worldSeq: number;
  readonly worldTick: number;
}

export interface RestoreSnapshotInput {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
  readonly expected?: RestoreExpectation;
}

/** 恢复提交结果：新在线分支、绑定的新 run 与被替换的旧在线分支。 */
export interface RestoreResult {
  readonly branchId: string;
  readonly runId: string;
  readonly worldId: string;
  readonly previousBranchId: string;
  readonly sourceRunId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
}

/** 已校验的冻结快照：快照行与冻结分支一致，且冻结分支带完整时钟与事件前沿。 */
interface FrozenSnapshot {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly sourceRunId: string | null;
}

function numberValue(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${column} 不是安全整数`);
  }
  return value;
}

function stringValue(value: unknown, column: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${column} 不是非空字符串`);
  }
  return value;
}

function objectValue(value: StorageCell | undefined, column: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Uint8Array) {
    throw new Error(`${column} 不是 JSON 对象`);
  }
  return value as Json;
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

/**
 * 校验快照行、冻结分支与源分支属于同一份一致复制：冻结分支必须仍处于 frozen 且无 run，
 * 时钟 tick 与快照记录一致，事件前沿等于快照的 world_seq；任何缺失都视为快照不完整。
 */
function readFrozenSnapshot(tx: StorageTransaction, snapshotId: string): FrozenSnapshot {
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
    throw new Error(`快照源分支 ${sourceBranchId} 不是 online 分支，无法作为在线恢复来源`);
  }
  const worldId = stringValue(sourceBranch["world_id"], "branches.world_id");

  const frozen = tx.rows("branches").get({ branch_id: frozenBranchId });
  if (frozen === null) {
    throw new Error(`快照冻结分支 ${frozenBranchId} 不存在`);
  }
  if (frozen["kind"] !== "snapshot" || frozen["status"] !== "frozen" || frozen["run_id"] !== null) {
    throw new Error("快照冻结分支状态不合法");
  }
  if (frozen["world_id"] !== worldId) {
    throw new Error("快照冻结分支与源分支不属于同一 world");
  }
  if (frozen["parent_branch_id"] !== sourceBranchId) {
    throw new Error("快照冻结分支的父分支与快照源分支不一致");
  }

  const clock = tx.branch(frozenBranchId).table("clock").get({});
  if (clock === null) {
    throw new Error(`快照冻结分支 ${frozenBranchId} 缺少时钟记录`);
  }
  if (numberValue(clock["world_tick"], "clock.world_tick") !== worldTick) {
    throw new Error(`快照 ${snapshotId} 的 worldTick 与冻结分支时钟不一致`);
  }
  if (maxWorldSeq(tx, frozenBranchId) !== worldSeq) {
    throw new Error(`快照 ${snapshotId} 的 worldSeq 与冻结分支事件前沿不一致`);
  }

  const sourceRunId = typeof sourceBranch["run_id"] === "string" && sourceBranch["run_id"].length > 0
    ? sourceBranch["run_id"]
    : null;
  return { snapshotId, sourceBranchId, frozenBranchId, worldId, worldSeq, worldTick, sourceRunId };
}

/** 读取源分支已冻结的 run；恢复沿用它的 RunSpec、seed 与 manifest，不再按当前入参重建。 */
function readSourceRun(tx: StorageTransaction, frozen: FrozenSnapshot): SnapshotSourceRun {
  if (frozen.sourceRunId === null) {
    throw new Error(`快照源分支 ${frozen.sourceBranchId} 没有绑定 run，无法沿用运行规格`);
  }
  const run = tx.rows("runs").get({ run_id: frozen.sourceRunId });
  if (run === null) {
    throw new DomainError("not-found", `快照源 run ${frozen.sourceRunId} 不存在`, {
      details: { runId: frozen.sourceRunId },
    });
  }
  if (run["world_id"] !== frozen.worldId) {
    throw new Error(`快照源 run ${frozen.sourceRunId} 与快照不属于同一 world`);
  }
  if (run["branch_id"] !== frozen.sourceBranchId) {
    throw new Error(`快照源 run ${frozen.sourceRunId} 绑定的分支与快照源分支不一致`);
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
function inspectSnapshot(tx: StorageTransaction, snapshotId: string): RestoreInspection {
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

function assertExpectedSource(expected: RestoreExpectation, inspection: RestoreInspection): void {
  const matches =
    expected.sourceRunId === inspection.sourceRun.runId &&
    expected.manifestHash === inspection.sourceRun.manifestHash &&
    expected.canonicalRunSpec === canonicalJson(inspection.sourceRun.runSpec) &&
    expected.worldSeq === inspection.worldSeq &&
    expected.worldTick === inspection.worldTick;
  if (!matches) {
    throw new Error("快照源 run 在 dry-run 后被修改，拒绝按旧校验结果恢复");
  }
}

/**
 * 当前 campaign 的在线分支集合：从在线别名分支沿 parent_branch_id 向上追溯，
 * 只收集链上的 online 分支（跨越恢复产生的冻结分支）；其他 campaign、实验与沙盒分支不在链上。
 */
function campaignBranchIds(tx: StorageTransaction): ReadonlySet<string> {
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

function snapshotRecordOf(row: StorageRow): SnapshotRecord {
  return {
    snapshotId: stringValue(row["snapshot_id"], "snapshots.snapshot_id"),
    sourceBranchId: stringValue(row["source_branch_id"], "snapshots.source_branch_id"),
    frozenBranchId: stringValue(row["frozen_branch_id"], "snapshots.frozen_branch_id"),
    worldSeq: numberValue(row["world_seq"], "snapshots.world_seq"),
    worldTick: numberValue(row["world_tick"], "snapshots.world_tick"),
    label: stringValue(row["label"], "snapshots.label"),
    createdAt: stringValue(row["created_at"], "snapshots.created_at"),
  };
}

/** SQLite 存档实现；恢复在一次存储事务内完成分支、run、旧分支归档与在线别名切换。 */
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
   * 从快照切换在线世界：创建后继分支与绑定源 RunSpec 的新 run、结束旧 run、归档旧分支，
   * 并原子切换 world_aliases('online')；任一步失败整体回滚，旧分支与别名保持原状。
   */
  restoreSnapshot(input: RestoreSnapshotInput): RestoreResult {
    return this.storage.transact((tx) => this.restoreSnapshotInTransaction(tx, input));
  }

  /**
   * 在调用方已开启的事务内从快照切换在线世界；供宿主把运营幂等记录并入同一次提交。
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

/** 存档服务公开类型；调用方只依赖这些方法。 */
export type SaveService = Pick<
  SqliteSaveService,
  | "createSnapshot"
  | "createSnapshotInTransaction"
  | "listSnapshots"
  | "inspectRestore"
  | "inspectRestoreInTransaction"
  | "restoreSnapshot"
  | "restoreSnapshotInTransaction"
>;
