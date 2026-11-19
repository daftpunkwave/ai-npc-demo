/**
 * 在一次 authority 事务内按模块所有权构造可绑定的模块端口。
 * 依赖规则注册表、存储事务与 WorldTx；端口只能通过返回的 txFor 取得目标模块的写作用域。
 * 禁止把调用方自己的 WorldTx 直接交给其他模块，或在模块未注册时静默降级为无写入端口。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import { DomainError, type HostServices, type StorageTransaction } from "@ai-npc/contracts";
import type { ModuleBinder, ScopedWorldTxFactory, WorldTx } from "@ai-npc/module-sdk";
import type { RuleRegistry } from "./rule-registry";
import { TransactionWorldTx, type TxCollector } from "./world-tx";

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
  readonly collector?: TxCollector;
}

/** 按模块声明构造事务工厂所需的固定上下文；correlationId 按模块展开。 */
export interface ModuleScopeInput {
  readonly registry: RuleRegistry;
  readonly storageTx: StorageTransaction;
  readonly worldId: string;
  readonly branchId: string;
  readonly worldTick: number;
  readonly principalId: string;
  // eslint-disable-next-line no-unused-vars -- 接口/函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  readonly correlationId: (moduleId: string) => string;
  readonly host: HostServices;
  readonly collector?: TxCollector;
}

/**
 * 按模块注册时声明的 ownsAggregates 构造同一事务内的 WorldTx 工厂。
 * 未注册的模块直接失败，不授予默认或全量写作用域；同一模块在一次绑定内复用同一实例。
 */
export function createScopedWorldTxFactory(input: ModuleScopeInput): ScopedWorldTxFactory {
  const bound = new Map<string, WorldTx>();
  return (moduleId: string): WorldTx => {
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
      correlationId: input.correlationId(moduleId),
      scope: owner,
      host: input.host,
      collector: input.collector,
    });
    bound.set(moduleId, tx);
    return tx;
  };
}

/**
 * 构造本次处理器专用的模块端口；未配置 binder 时沿用静态模块对象。
 * 同一个模块在一次绑定内复用同一个 WorldTx，避免重复读取与版本漂移。
 */
export function bindModulePorts(input: ModuleBindingInput): unknown {
  if (input.binder === undefined) {
    return input.fallback;
  }
  const txFor = createScopedWorldTxFactory({
    registry: input.registry,
    storageTx: input.storageTx,
    worldId: input.worldId,
    branchId: input.branchId,
    worldTick: input.worldTick,
    principalId: input.principalId,
    correlationId: () => input.correlationId,
    host: input.host,
    collector: input.collector,
  });
  return input.binder(txFor);
}
