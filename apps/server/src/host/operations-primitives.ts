/**
 * 运营基础操作：暂停排空、快照、重开与恢复的事务内实现，以及恢复来源的兼容性裁决。
 * 依赖存档服务、时钟 provider、在线入口、内容与冻结 manifest；不写幂等记录、不做请求级去重。
 * 禁止在未暂停时快照、跳过来源校验、在失败时留下孤立快照或半切换别名，
 * 或用普通异常表示可预期的来源不兼容。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import {
  DomainError,
  canonicalJson,
  type AssemblyDescriptor,
  type ClockView,
  type Json,
  type StoragePort,
  type StorageRow,
  type StorageTransaction,
} from "@world-prism/contracts";
import type { HostServices } from "@world-prism/contracts";
import type { ConfigLoadContext, ContentPack, RunSpec } from "@world-prism/experiment";
import { loadRoster, runSpecSchema, validateRoster, validateRunSpec } from "@world-prism/experiment";
import type { ClockState } from "@world-prism/module-sdk";
import { loadAssembly } from "./assembly";
import { clockView } from "./clock-view";
import { switchLiveBranch, type LiveRunState } from "./live-state";
import type { ServerRuntime } from "./module-catalog";
import type { RunManifest } from "./manifest";
import { readFrozenManifest } from "./manifest";
import type { OperationKind, OperationKey } from "./operation-journal";
import { operationRequestHash } from "./operation-journal";
import { readOnlineEntry } from "./online-entry";

export interface OperationsPrimitivesInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly runtime: ServerRuntime;
  readonly active: LiveRunState;
  readonly runSpec: RunSpec;
  readonly frozenManifest: RunManifest;
  readonly frozenManifestHash: string;
  readonly activeAssembly: Pick<AssemblyDescriptor, "assemblyId">;
  readonly packId: string;
  readonly contentVersion: string;
  readonly content: ContentPack;
  readonly loadContext: ConfigLoadContext;
  readonly clockState: () => ClockState;
  /** 时钟控制回调；step 携带本步推进的 tick 数。 */
  readonly control: (
    mode: "pause" | "start" | "step",
    expectedRunVersion: number,
    ticks?: number,
  ) => ClockView;
  /** 补完当前 tick 的到期 job 与消费者；由组合根绑定 authority 与存储。 */
  readonly catchUpCurrentTick: () => void;
  readonly activateRestoredRoster?: (tx: StorageTransaction, branchId: string) => void;
}

/** 运营基础操作集合；幂等包装与驱动组装在相邻模块完成。 */
export interface OperationsPrimitives {
  operationKeyFor(kind: OperationKind, principalId: string, operationId: string, content: Json): OperationKey;
  prepareSnapshot(): void;
  createDrainedSnapshot(input: {
    readonly label: string;
    readonly createdBy: string;
  }): ReturnType<ServerRuntime["save"]["createSnapshot"]>;
  resetInTransaction(tx: StorageTransaction, createdBy: string): { readonly branchId: string; readonly clock: ClockView };
  resetOnline(): { readonly branchId: string; readonly clock: ClockView };
  validateRestoreSource(inspection: ReturnType<ServerRuntime["save"]["inspectRestore"]>): void;
  activateRestoredRoster(tx: StorageTransaction, branchId: string): void;
  restoreOnlineRun(input: {
    readonly snapshotId: string;
    readonly createdBy: string;
    readonly runId?: string;
  }): ReturnType<ServerRuntime["save"]["restoreSnapshot"]>;
}

/** 构造运营基础操作；所有写操作都依赖调用方已暂停并排空当前 tick。 */
export function createOperationsPrimitives(input: OperationsPrimitivesInput): OperationsPrimitives {
  const { host, storage, runtime, active, runSpec, frozenManifest, frozenManifestHash, activeAssembly } = input;
  const save = runtime.save;
  const activateRestoredRoster = (tx: StorageTransaction, branchId: string): void =>
    input.activateRestoredRoster?.(tx, branchId);

  const operationKeyFor = (
    kind: OperationKind,
    principalId: string,
    operationId: string,
    content: Json,
  ): OperationKey => ({
    kind,
    worldId: active.worldId,
    principalId,
    operationId,
    requestHash: operationRequestHash(kind, content),
  });

  /** 快照前的受控准备：运行或单步中先暂停，再幂等补完当前 tick 的到期 job 与消费者。 */
  const prepareSnapshot = (): void => {
    const current = input.clockState();
    if (current.mode === "running" || current.mode === "stepping") {
      input.control("pause", current.runVersion);
    }
    input.catchUpCurrentTick();
  };

  const createDrainedSnapshot = (
    snapshotInput: { readonly label: string; readonly createdBy: string },
  ): ReturnType<ServerRuntime["save"]["createSnapshot"]> => {
    input.catchUpCurrentTick();
    return save.createSnapshot({ sourceBranchId: active.branchId, label: snapshotInput.label, createdBy: snapshotInput.createdBy });
  };

  /**
   * 重开的单事务部分：先把当前在线世界冻结为快照，再创建新的空在线分支与 live run、
   * 结束旧 run、归档旧分支并切换在线别名；调用方负责先暂停并补完 tick。
   */
  const resetInTransaction = (
    tx: StorageTransaction,
    createdBy: string,
  ): { readonly branchId: string; readonly clock: ClockView } => {
    const alias = tx.rows("world_aliases").get({ alias: "online" });
    if (alias === null || alias["branch_id"] !== active.branchId) {
      throw new DomainError("invalid-state", "在线别名在重开事务内发生变化，拒绝切换");
    }
    const previous = tx.rows("branches").get({ branch_id: active.branchId });
    if (previous === null) {
      throw new DomainError("invalid-state", `在线分支 ${active.branchId} 不存在，拒绝重开`);
    }
    if (previous["kind"] !== "online") {
      throw new DomainError("invalid-state", `在线分支 ${active.branchId} 不是 online 分支，拒绝重开`);
    }
    const previousStatus = previous["status"];
    if (previousStatus !== "active" && previousStatus !== "paused") {
      throw new DomainError("invalid-state", `在线分支 ${active.branchId} 状态为 ${String(previousStatus)}，拒绝重开`);
    }
    const previousRunId = typeof previous["run_id"] === "string" ? previous["run_id"] : "";
    const previousRun = previousRunId.length === 0 ? null : tx.rows("runs").get({ run_id: previousRunId });
    if (previousRun === null) {
      throw new DomainError("invalid-state", `在线分支 ${active.branchId} 没有绑定 run，拒绝重开`);
    }
    const clockRow = runtime.clock.readInTransaction(tx, active.branchId);
    const now = host.nowIso();
    const nextBranchId = host.ids("br");
    const nextRunId = host.ids("run");
    // 重开前的快照与后续分支切换同事务提交，避免失败时留下孤立快照或半切换别名。
    save.createSnapshotInTransaction(tx, {
      sourceBranchId: active.branchId,
      label: `reset-${clockRow.worldTick}`,
      createdBy,
    });
    const nextBranch: StorageRow = {
      branch_id: nextBranchId,
      world_id: active.worldId,
      kind: "online",
      status: "active",
      parent_branch_id: active.branchId,
      forked_at_world_seq: null,
      run_id: null,
      profile_hash: null,
      created_at: now,
    };
    tx.rows("branches").put(nextBranch);
    tx.rows("runs").put({
      run_id: nextRunId,
      world_id: active.worldId,
      branch_id: nextBranchId,
      mode: "live",
      status: "running",
      run_spec_json: runSpec,
      manifest_json: frozenManifest as unknown as Json,
      manifest_hash: frozenManifestHash,
      contaminated: 0,
      evidence_complete: 1,
      created_at: now,
      started_at: now,
      ended_at: null,
    });
    tx.rows("branches").put({ ...nextBranch, run_id: nextRunId });
    // 新分支的初始时钟行由 provider 写入同一事务，秒数取 provider 有效配置。
    runtime.clock.initializeInTransaction(tx, nextBranchId);
    tx.rows("runs").put({ ...previousRun, status: "completed", ended_at: now });
    tx.rows("branches").put({ ...previous, status: "archived" });
    tx.rows("world_aliases").put({ alias: "online", branch_id: nextBranchId, updated_at: now });
    return { branchId: nextBranchId, clock: clockView(runtime.clock.readInTransaction(tx, nextBranchId)) };
  };

  /**
   * 重开：先把当前在线世界存为快照，再在同一事务内创建新的空在线分支与 live run、
   * 结束旧 run、归档旧分支并切换在线别名；重启后从别名选中新分支。
   */
  const resetOnline = (): { readonly branchId: string; readonly clock: ClockView } => {
    const online = storage.transact(readOnlineEntry);
    if (online === null) {
      throw new DomainError("invalid-state", "没有 world_aliases('online')，拒绝重开");
    }
    if (online.branchId !== active.branchId) {
      throw new DomainError(
        "invalid-state",
        `在线别名指向 ${online.branchId}，与宿主分支 ${active.branchId} 不一致；拒绝重开`,
      );
    }
    prepareSnapshot();
    const result = storage.transact((tx) => resetInTransaction(tx, "operator-1"));
    switchLiveBranch(active, result.branchId);
    return result;
  };

  /**
   * 恢复 dry-run 的内容与模块兼容性裁决：内容包版本、RunSpec、装配、名册与冻结 manifest
   * 必须仍与当前宿主一致；任何不兼容都在写入前以稳定领域错误失败，不产生快照副本或别名变更。
   */
  const validateRestoreSource = (inspection: ReturnType<ServerRuntime["save"]["inspectRestore"]>): void => {
    const parsed = runSpecSchema.safeParse(inspection.sourceRun.runSpec);
    if (!parsed.success) {
      throw new DomainError("invalid-state", "快照源 run 的 RunSpec 无法解析，拒绝恢复", {
        details: { snapshotId: inspection.snapshotId, sourceRunId: inspection.sourceRun.runId },
      });
    }
    const sourceSpec = parsed.data;
    const facts = readFrozenManifest(inspection.sourceRun.manifest);
    if (facts.packId !== input.packId) {
      throw new DomainError("invalid-state", `内容包不一致：快照源 run 冻结「${facts.packId}」，当前内容包「${input.packId}」；拒绝恢复`, {
        details: { sourcePackId: facts.packId, currentPackId: input.packId },
      });
    }
    if (facts.contentVersion !== input.contentVersion) {
      throw new DomainError(
        "invalid-state",
        `内容包 contentVersion 不一致：快照源 run 冻结「${facts.contentVersion}」，当前内容包「${input.contentVersion}」；拒绝恢复`,
        { details: { sourceContentVersion: facts.contentVersion, currentContentVersion: input.contentVersion } },
      );
    }
    if (facts.seed !== sourceSpec.seed) {
      throw new DomainError("invalid-state", "快照源 run 的 seed 与 RunSpec 不一致，拒绝恢复", {
        details: { sourceRunId: inspection.sourceRun.runId },
      });
    }
    if (facts.moduleAssemblyRef !== sourceSpec.moduleAssemblyRef) {
      throw new DomainError("invalid-state", "快照源 run 的装配引用与 RunSpec 不一致，拒绝恢复", {
        details: {
          sourceAssemblyRef: facts.moduleAssemblyRef,
          runSpecAssemblyRef: sourceSpec.moduleAssemblyRef,
        },
      });
    }
    if (facts.rosterRef !== sourceSpec.rosterRef) {
      throw new DomainError("invalid-state", "快照源 run 的名册引用与 RunSpec 不一致，拒绝恢复", {
        details: { sourceRosterRef: facts.rosterRef, runSpecRosterRef: sourceSpec.rosterRef },
      });
    }
    if (sourceSpec.worldPackRef !== input.packId) {
      throw new DomainError(
        "invalid-state",
        `快照源 RunSpec 的 worldPackRef「${sourceSpec.worldPackRef}」与当前内容包「${input.packId}」不一致；拒绝恢复`,
        { details: { sourceWorldPackRef: sourceSpec.worldPackRef, currentPackId: input.packId } },
      );
    }
    if (inspection.sourceRun.manifestHash !== frozenManifestHash) {
      throw new DomainError(
        "invalid-state",
        "快照源 run 的冻结 manifest 与当前在线 run 不一致（模块、名册或内容版本不同）；拒绝恢复",
        { details: { snapshotId: inspection.snapshotId, sourceRunId: inspection.sourceRun.runId } },
      );
    }
    if (canonicalJson(sourceSpec as unknown as Json) !== canonicalJson(runSpec as unknown as Json)) {
      throw new DomainError("invalid-state", "快照源 run 的 RunSpec 与当前在线 run 不一致，拒绝恢复", {
        details: { sourceRunId: inspection.sourceRun.runId },
      });
    }
    const assembly = loadAssembly(sourceSpec.moduleAssemblyRef);
    if (assembly.assemblyId !== activeAssembly.assemblyId) {
      throw new DomainError(
        "invalid-state",
        `快照源 run 的装配「${assembly.assemblyId}」与当前在线装配「${activeAssembly.assemblyId}」不一致；拒绝恢复`,
        { details: { sourceAssemblyId: assembly.assemblyId, activeAssemblyId: activeAssembly.assemblyId } },
      );
    }
    const roster = loadRoster(sourceSpec.rosterRef, input.loadContext);
    validateRoster(roster.value, input.content);
    validateRunSpec(sourceSpec, input.content, roster);
  };

  /**
   * 从快照恢复：先 dry-run 校验内容与运行规格兼容性，再在同一事务内建立后继分支与 run、
   * 结束旧 run、归档旧分支并切换在线别名；提交后更新宿主内存中的在线分支与世界。
   */
  const restoreOnlineRun = (restoreInput: {
    readonly snapshotId: string;
    readonly createdBy: string;
    readonly runId?: string;
  }): ReturnType<ServerRuntime["save"]["restoreSnapshot"]> => {
    const inspection = save.inspectRestore(restoreInput.snapshotId);
    validateRestoreSource(inspection);
    const restored = storage.transact((tx) => {
      const restored = save.restoreSnapshotInTransaction(tx, {
        snapshotId: restoreInput.snapshotId,
        createdBy: restoreInput.createdBy,
        ...(restoreInput.runId === undefined ? {} : { runId: restoreInput.runId }),
        expected: {
          sourceRunId: inspection.sourceRun.runId,
          canonicalRunSpec: canonicalJson(inspection.sourceRun.runSpec),
          manifestHash: inspection.sourceRun.manifestHash,
          worldSeq: inspection.worldSeq,
          worldTick: inspection.worldTick,
        },
      });
      activateRestoredRoster(tx, restored.branchId);
      return restored;
    });
    switchLiveBranch(active, restored.branchId, restored.worldId);
    return restored;
  };

  return {
    operationKeyFor,
    prepareSnapshot,
    createDrainedSnapshot,
    resetInTransaction,
    resetOnline,
    validateRestoreSource,
    activateRestoredRoster,
    restoreOnlineRun,
  };
}
