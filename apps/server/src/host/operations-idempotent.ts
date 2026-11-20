/**
 * 运营操作的幂等执行：暂停/继续、快照、恢复与重开按 operationId 复用首次结果，冲突或失败记录同键。
 * 依赖运营幂等日志、基础操作、存档 InTransaction 方法与时钟 provider；不重算业务结果。
 * 禁止在业务写入之外单独提交结果（时钟控制除外），或让失败记录被后续重试覆盖。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import { DomainError, canonicalJson, type ClockView, type StoragePort } from "@ai-npc/contracts";
import { clockView } from "./clock-view";
import type { LiveRunState } from "./live-state";
import type {
  IdempotentOperationsDriver,
  OperationRequest,
  RestoreInput,
  ServerRuntime,
  SnapshotInput,
} from "./module-catalog";
import type { OperationJournal, OperationKey } from "./operation-journal";
import {
  decodeBranchClockOutcome,
  decodeClockOutcome,
  decodeSnapshotOutcome,
  toJsonResult,
} from "./operation-journal";
import { readOnlineEntry } from "./online-entry";
import type { OperationsPrimitives } from "./operations-primitives";

export interface IdempotentOperationsInput {
  readonly storage: StoragePort;
  readonly runtime: ServerRuntime;
  readonly active: LiveRunState;
  readonly journal: OperationJournal;
  readonly primitives: OperationsPrimitives;
  readonly control: (mode: "pause" | "start", expectedRunVersion: number) => ClockView;
}

/** 构造幂等执行入口；每个操作先查首次结果，再在业务事务内写入首次记录。 */
export function createIdempotentOperations(input: IdempotentOperationsInput): IdempotentOperationsDriver {
  const { storage, runtime, active, journal, primitives, control } = input;
  const save = runtime.save;

  /**
   * 暂停/继续的幂等执行。时钟 provider 自持事务，结果记录只能随后单独提交，
   * 两次提交之间崩溃会退化为重新执行一次时钟控制，不承诺该窗口的原子性。
   */
  const controlOperation = (
    kind: "pause" | "resume",
    expectedRunVersion: number,
    operation: OperationRequest,
  ): ClockView => {
    const key: OperationKey = primitives.operationKeyFor(kind, operation.principalId, operation.operationId, {
      expectedRunVersion,
    });
    const replayed = journal.replay(key, decodeClockOutcome);
    if (replayed !== null) {
      return replayed;
    }
    let clock: ClockView;
    try {
      clock = control(kind === "pause" ? "pause" : "start", expectedRunVersion);
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
    journal.recordSuccessStandalone(key, toJsonResult(clock));
    return clock;
  };

  /** 快照的幂等执行：首次结果与冻结分支、快照行在同一事务提交。 */
  const snapshotOperation = (
    operation: OperationRequest,
    snapshotInput: SnapshotInput,
  ): { readonly snapshotId: string; readonly worldTick: number } => {
    const key = primitives.operationKeyFor("snapshot", operation.principalId, operation.operationId, {
      label: snapshotInput.label,
    });
    const replayed = journal.replay(key, decodeSnapshotOutcome);
    if (replayed !== null) {
      return replayed;
    }
    try {
      primitives.prepareSnapshot();
      return storage.transact((tx) => {
        const stored = journal.read(tx, key);
        if (stored !== null) {
          return journal.materialize(stored, decodeSnapshotOutcome);
        }
        const created = save.createSnapshotInTransaction(tx, {
          sourceBranchId: active.branchId,
          label: snapshotInput.label,
          createdBy: snapshotInput.createdBy,
        });
        const outcome = { snapshotId: created.snapshotId, worldTick: created.worldTick };
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return outcome;
      });
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  /** 恢复的幂等执行：首次结果、后继分支/run 与别名切换在同一事务提交。 */
  const restoreOperation = (
    operation: OperationRequest,
    restoreInput: RestoreInput,
  ): { readonly branchId: string; readonly clock: ClockView; readonly applied?: boolean } => {
    const key = primitives.operationKeyFor("restore", operation.principalId, operation.operationId, {
      snapshotId: restoreInput.snapshotId,
      ...(restoreInput.runId === undefined ? {} : { runId: restoreInput.runId }),
    });
    const replayed = journal.replay(key, decodeBranchClockOutcome);
    if (replayed !== null) {
      // 重放不切换分支：返回首次结果供调用方读取，同时标记本次没有应用切换。
      return { ...replayed, applied: false };
    }
    try {
      const committed = storage.transact((tx) => {
        const stored = journal.read(tx, key);
        if (stored !== null) {
          return { outcome: journal.materialize(stored, decodeBranchClockOutcome), applied: false as const };
        }
        const inspection = save.inspectRestoreInTransaction(tx, restoreInput.snapshotId);
        primitives.validateRestoreSource(inspection);
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
        const outcome = {
          branchId: restored.branchId,
          clock: clockView(runtime.clock.readInTransaction(tx, restored.branchId)),
        };
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return { outcome, applied: true as const, worldId: restored.worldId };
      });
      if (committed.applied) {
        active.branchId = committed.outcome.branchId;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 旧快照可能缺少 worldId 字段，保留兜底。
        active.worldId = committed.worldId ?? active.worldId;
      }
      return { ...committed.outcome, applied: committed.applied };
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  /** 重开的幂等执行：重开前的快照与分支切换同事务，结果同事务写入。 */
  const resetOperation = (operation: OperationRequest): {
    readonly branchId: string;
    readonly clock: ClockView;
    readonly applied?: boolean;
  } => {
    const key = primitives.operationKeyFor("reset", operation.principalId, operation.operationId, {});
    const replayed = journal.replay(key, decodeBranchClockOutcome);
    if (replayed !== null) {
      // 重放不切换分支：返回首次结果供调用方读取，同时标记本次没有应用切换。
      return { ...replayed, applied: false };
    }
    try {
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
      primitives.prepareSnapshot();
      const committed = storage.transact((tx) => {
        const stored = journal.read(tx, key);
        if (stored !== null) {
          return { outcome: journal.materialize(stored, decodeBranchClockOutcome), applied: false as const };
        }
        const outcome = primitives.resetInTransaction(tx, operation.principalId);
        journal.recordSuccess(tx, key, toJsonResult(outcome));
        return { outcome, applied: true as const };
      });
      if (committed.applied) {
        active.branchId = committed.outcome.branchId;
      }
      return { ...committed.outcome, applied: committed.applied };
    } catch (error) {
      journal.recordFailure(key, error);
      throw error;
    }
  };

  return {
    pause: (operation, expected) => controlOperation("pause", expected, operation),
    resume: (operation, expected) => controlOperation("resume", expected, operation),
    snapshot: (operation, snapshotInput) => snapshotOperation(operation, snapshotInput),
    restore: (operation, restoreInput) => restoreOperation(operation, restoreInput),
    reset: (operation) => resetOperation(operation),
  };
}
