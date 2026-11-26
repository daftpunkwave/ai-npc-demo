/**
 * 核心职责：从已解析装配与已启动实例构造游戏模块的事务内端口绑定器与规则贡献。
 * 交互契约：依赖 kernel 的实例计划、已启动实例的公开端口、内容索引与宿主 ID 服务；
 * 绑定器按计划的拓扑顺序构造端口，处理器只得到自身能力与 requires 声明的端口。
 * 约束与禁忌：禁止按模块 ID 挑选实现、跳过 requires 限制或把全部端口交给任意处理器。
 */
import { DomainError, type HostServices } from "@world-prism/contracts";
import type { PlannedModule, ResolvedRealmPlan, RunningInstance } from "@world-prism/kernel";
import {
  gamePortCapabilities,
  type GameContent,
  type GameIdFactory,
  type GameModulePorts,
  type GamePortBindContext,
  type GameRuleContributor,
  type ModuleBinder,
  type ScopedWorldTxFactory,
} from "@world-prism/module-sdk";

/** 模块实例公开端口的最小结构：事务绑定器与可选的规则贡献。 */
export interface GameModulePublicPort {
  readonly bind: (
    txFor: ScopedWorldTxFactory,
    content: GameContent,
    ids: GameIdFactory,
    context: GamePortBindContext,
  ) => unknown;
  readonly contributor?: GameRuleContributor<GameModulePorts, unknown>;
}

/** 一个已绑定游戏模块：提供的能力、声明的依赖与端口绑定函数。 */
interface GameModuleBinding {
  readonly moduleId: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly bind: GameModulePublicPort["bind"];
}

/** 一个装配的游戏模块绑定结果；binder 供 authority 与宿主只读端口使用。 */
export interface GameModuleBindings {
  readonly binder: ModuleBinder;
  readonly contributors: readonly GameRuleContributor<GameModulePorts, unknown>[];
}

const gameCapabilitySet: ReadonlySet<string> = new Set(gamePortCapabilities);

/** 判断能力名是否属于游戏端口全集。 */
function isGameCapability(capability: string): boolean {
  return gameCapabilitySet.has(capability);
}

/** 只保留描述符中声明的游戏能力，忽略平台与传输能力。 */
function gameCapabilitiesOf(planned: PlannedModule): readonly string[] {
  return planned.definition.provides
    .map((provided) => provided.capability as string)
    .filter(isGameCapability);
}

/** 请求端口视图的调用方身份；宿主自身与具体模块用于区分端口触发来源。 */
interface PortCaller {
  readonly moduleId: string | null;
  readonly provides: readonly string[];
}

/** 一次绑定请求的调用方：宿主拿全部端口，模块拿自身与 requires。 */
function callerOf(
  bindings: readonly GameModuleBinding[],
  moduleId: string | null,
): PortCaller {
  if (moduleId === null) {
    return { moduleId: null, provides: [] };
  }
  const binding = bindings.find((candidate) => candidate.moduleId === moduleId);
  if (binding === undefined) {
    throw new DomainError("module-missing", `模块 ${moduleId} 未注册游戏端口绑定`, {
      details: { moduleId },
    });
  }
  return { moduleId, provides: binding.provides };
}

/** 把调用方处理器可见的端口收窄到自身能力与 requires；其余能力访问立即失败。 */
function restrictGamePorts(
  ports: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  moduleId: string,
): GameModulePorts {
  const isUndeclared = (property: PropertyKey): boolean =>
    typeof property === "string" && isGameCapability(property) && !allowed.has(property);
  return new Proxy(ports, {
    get(target, property, receiver) {
      if (isUndeclared(property)) {
        throw new DomainError(
          "forbidden",
          `模块 ${moduleId} 未声明能力 ${String(property)}，不能读取该端口`,
          { details: { moduleId, capability: String(property) } },
        );
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return !isUndeclared(property) && Reflect.has(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((property) => !isUndeclared(property));
    },
    getOwnPropertyDescriptor(target, property) {
      if (isUndeclared(property)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  }) as unknown as GameModulePorts;
}

/**
 * 按计划拓扑顺序构造全部游戏端口。
 * 每个模块的绑定器只收到它 requires 声明的已绑定端口；缺失说明装配或顺序错误，直接失败。
 */
function bindGamePorts(
  bindings: readonly GameModuleBinding[],
  txFor: ScopedWorldTxFactory,
  content: GameContent,
  host: HostServices,
  caller: PortCaller,
): Readonly<Record<string, unknown>> {
  const bound: Record<string, unknown> = {};
  for (const binding of bindings) {
    const dependencyPorts: Partial<Record<string, unknown>> = {};
    for (const capability of binding.requires) {
      const port = bound[capability];
      if (port === undefined) {
        throw new Error(
          `模块 ${binding.moduleId} 依赖的游戏能力 ${capability} 尚未绑定；` +
            "请检查装配解析的拓扑顺序与 requires 声明",
        );
      }
      dependencyPorts[capability] = port;
    }
    const port = binding.bind(txFor, content, (prefix) => host.ids(prefix), {
      // 冻结依赖端口记录，使绑定上下文成为不可变视图；端口实例仍绑定当前事务、在各模块间共享。
      ports: Object.freeze(dependencyPorts) as Readonly<Partial<GameModulePorts>>,
      callerModuleId: caller.moduleId,
      callerProvides: caller.provides,
    });
    for (const capability of binding.provides) {
      bound[capability] = port;
    }
  }
  return bound;
}

/**
 * 解析装配中的游戏模块并生成端口绑定器与规则贡献。
 * 计划的 modules 已由 kernel 按“提供者先于消费者”排序，这里不再维护第二份手工顺序。
 */
export function resolveGameModuleBindings(input: {
  readonly plan: ResolvedRealmPlan;
  readonly instances: readonly RunningInstance[];
  readonly content: GameContent;
  readonly host: HostServices;
}): GameModuleBindings {
  const instanceByModuleId = new Map(
    input.instances.map((instance) => [instance.moduleId, instance] as const),
  );
  const bindings: GameModuleBinding[] = [];
  const contributors: GameRuleContributor<GameModulePorts, unknown>[] = [];

  for (const planned of input.plan.modules) {
    const provides = gameCapabilitiesOf(planned);
    if (provides.length === 0) {
      continue;
    }
    const running = instanceByModuleId.get(planned.moduleId);
    if (running === undefined) {
      throw new Error(`模块 ${planned.moduleId} 没有启动实例`);
    }
    const port = running.port as Partial<GameModulePublicPort> | undefined;
    if (port === undefined || typeof port.bind !== "function") {
      throw new Error(`模块 ${planned.moduleId} 没有暴露事务端口绑定器`);
    }
    if (port.contributor === undefined) {
      throw new Error(`游戏模块 ${planned.moduleId} 没有通过公开端口暴露规则贡献`);
    }
    if (port.contributor.moduleId !== planned.moduleId) {
      throw new Error(
        `游戏模块 ${planned.moduleId} 暴露的规则贡献属于 ${port.contributor.moduleId}`,
      );
    }
    const requires = planned.requires
      .map((requirement) => requirement.capability as string)
      .filter(isGameCapability);
    bindings.push({
      moduleId: planned.moduleId,
      provides,
      requires,
      bind: port.bind,
    });
    contributors.push(port.contributor);
  }

  const binder: ModuleBinder = (txFor, moduleId) => {
    const caller = callerOf(bindings, moduleId);
    const ports = bindGamePorts(bindings, txFor, input.content, input.host, caller);
    if (moduleId === null) {
      return ports;
    }
    const binding = bindings.find((candidate) => candidate.moduleId === moduleId);
    if (binding === undefined) {
      throw new DomainError("module-missing", `模块 ${moduleId} 未注册游戏端口绑定`, {
        details: { moduleId },
      });
    }
    const allowed = new Set<string>([...binding.provides, ...binding.requires]);
    return restrictGamePorts(ports, allowed, moduleId);
  };

  return { binder, contributors };
}
