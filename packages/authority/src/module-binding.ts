/**
 * 在一次 authority 事务内按模块所有权构造可绑定的模块端口。
 * 依赖规则注册表、存储事务与 WorldTx；端口只能通过返回的 txFor 取得目标模块的写作用域。
 * 禁止把调用方自己的 WorldTx 直接交给其他模块，或在模块未注册时静默降级为无写入端口。
 */
import { DomainError, type HostServices, type StorageTransaction } from "@ai-npc/contracts";
import type { ModuleBinder, WorldTx } from "@ai-npc/module-sdk";
import type { RuleRegistry } from "./rule-registry";
import { TransactionWorldTx } from "./world-tx";

/** 绑定模块端口所需的固定事务上下文。 */
export interface ModuleBindingInput {
  readonly binder: ModuleBinder | undefined;
  readonly fallback: unknown;
  readonly registry: RuleRegistry;
  readonly storageTx: StorageTransaction;
  readonly worldId: string;
  readonly branchId: string;
  readonly worldTick: number;
  readonly principalId: string;
  readonly correlationId: string;
  readonly host: HostServices;
}

/**
 * 构造本次处理器专用的模块端口；未配置 binder 时沿用静态模块对象。
 * 同一个模块在一次绑定内复用同一个 WorldTx，避免重复读取与版本漂移。
 */
export function bindModulePorts(input: ModuleBindingInput): unknown {
  if (input.binder === undefined) {
    return input.fallback;
  }
  const bound = new Map<string, WorldTx>();
  const txFor = (moduleId: string): WorldTx => {
    const existing = bound.get(moduleId);
    if (existing !== undefined) {
      return existing;
    }
    const owner = input.registry.contributor(moduleId);
    if (owner === undefined) {
      throw new DomainError("module-missing", `模块 ${moduleId} 未注册，不能绑定其写作用域`, {
        details: { moduleId },
      });
    }
    const tx = new TransactionWorldTx({
      storageTx: input.storageTx,
      worldId: input.worldId,
      branchId: input.branchId,
      worldTick: input.worldTick,
      principalId: input.principalId,
      correlationId: input.correlationId,
      scope: owner,
      host: input.host,
    });
    bound.set(moduleId, tx);
    return tx;
  };
  return input.binder(txFor);
}
