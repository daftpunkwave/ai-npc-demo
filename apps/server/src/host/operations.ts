/**
 * 运营编排：组合基础操作与幂等执行，向传输层暴露暂停/继续、受控单步、快照、恢复与重开。
 * 依赖运营模块的服务工厂、基础操作与幂等执行；不直接操作传输、路由或存储表。
 * 禁止改写幂等语义、跳过暂停排空或绕过 operationId 重放首次结果。
 */
import { DomainError, type RestoreDryRunResponse } from "@ai-npc/contracts";
import type { OperationsFactory } from "./module-catalog";
import type { OperationJournal } from "./operation-journal";
import { createIdempotentOperations } from "./operations-idempotent";
import type { OperationsPrimitivesInput } from "./operations-primitives";
import { createOperationsPrimitives } from "./operations-primitives";

export interface OperationsHostInput extends OperationsPrimitivesInput {
  readonly journal: OperationJournal;
}

/** 构造运营服务：幂等入口优先，非幂等回调保留给不带 operationId 的调用方。 */
export function createOperationsHost(input: OperationsHostInput): ReturnType<OperationsFactory["create"]> {
  const primitives = createOperationsPrimitives(input);
  const idempotent = createIdempotentOperations({
    storage: input.storage,
    runtime: input.runtime,
    active: input.active,
    journal: input.journal,
    primitives,
    control: input.control,
  });
  return input.runtime.operations.create({
    clock: () => input.clockState(),
    pause: (expected) => input.control("pause", expected),
    resume: (expected) => input.control("start", expected),
    step: (expected, ticks) => input.control("step", expected, ticks),
    snapshot: (snapshotInput) =>
      primitives.createDrainedSnapshot({ label: snapshotInput.label, createdBy: snapshotInput.createdBy }),
    restore: (restoreInput) => primitives.restoreOnlineRun(restoreInput),
    validateRestore: (snapshotId): RestoreDryRunResponse => {
      let inspection;
      try {
        inspection = input.runtime.save.inspectRestore(snapshotId);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "invalid-state") throw error;
        return { ok: false, checks: [{ name: "snapshot-integrity", ok: false, message: error.safeMessage }] };
      }
      if (inspection.worldId !== input.active.worldId) {
        return { ok: false, checks: [{ name: "world", ok: false, message: "快照不属于当前在线世界" }] };
      }
      let sourceError: string | null = null;
      try {
        primitives.validateRestoreSource(inspection);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "invalid-state") throw error;
        sourceError = error.safeMessage;
      }
      const ok = sourceError === null;
      return {
        ok,
        checks: [
          { name: "snapshot-integrity", ok: true, message: null },
          { name: "source-run", ok, message: sourceError ?? inspection.sourceRun.runId },
          { name: "world", ok: true, message: inspection.worldId },
          { name: "checkpoint", ok: true, message: `t${inspection.worldTick} / seq ${inspection.worldSeq}` },
        ],
      };
    },
    reset: () => primitives.resetOnline(),
    idempotent,
  });
}
