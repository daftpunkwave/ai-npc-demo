/**
 * 运营编排：组合基础操作与幂等执行，向传输层暴露暂停/继续、快照、恢复与重开。
 * 依赖运营模块的服务工厂、基础操作与幂等执行；不直接操作传输、路由或存储表。
 * 禁止改写幂等语义、跳过暂停排空或绕过 operationId 重放首次结果。
 */
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
    snapshot: (snapshotInput) =>
      primitives.createDrainedSnapshot({ label: snapshotInput.label, createdBy: snapshotInput.createdBy }),
    restore: (restoreInput) => primitives.restoreOnlineRun(restoreInput),
    reset: primitives.resetOnline,
    idempotent,
  });
}
