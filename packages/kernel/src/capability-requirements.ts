/**
 * 校验一个能力引用在装配中的绑定数量、基数与实例作用域，供装配解析与宿主预检复用。
 * 依赖公共契约的能力/模块类型与 DomainError；不创建实例、不执行模块实现。
 * 禁止静默选择多个候选、放宽 exactly-one 唯一性或忽略实例作用域不兼容。
 */
import {
  DomainError,
  type CapabilityId,
  type CapabilityRef,
  type Cardinality,
  type InstanceScope,
  type Json,
  type ModuleDefinition,
  type Realm,
} from "@ai-npc/contracts";

/** 计划中引用的能力提供者身份；实例创建后据此取 port。 */
export interface PortProviderRef {
  readonly moduleId: string;
  readonly version: string;
}

/** 一个已解析的 requires 项：基数、作用域与按装配顺序排列的提供者。 */
export interface ResolvedRequirement {
  readonly capability: CapabilityId;
  readonly cardinality: Cardinality;
  readonly instanceScope: InstanceScope;
  readonly providers: readonly PortProviderRef[];
}

/** 能力提供者的最小视图：模块定义与其能力声明。 */
export interface CapabilityProvider {
  readonly definition: ModuleDefinition;
  readonly provided: CapabilityRef;
}

/** 能力消费方：模块的 requires 或宿主固定必需能力。 */
export interface CapabilityConsumer {
  readonly kind: "module" | "host";
  readonly moduleId: string | null;
}

const instanceScopeRank: Readonly<Record<InstanceScope, number>> = {
  deployment: 0,
  run: 1,
  branch: 2,
  agent: 3,
  session: 4,
};

/**
 * 判断提供者的实例作用域能否支撑消费方的期望：deployment 最宽、session 最窄，
 * 提供者必须不窄于消费方要求的生命周期，跨作用域的窄提供者会留下悬空实例。
 */
export function isInstanceScopeCompatible(providerScope: InstanceScope, requiredScope: InstanceScope): boolean {
  return instanceScopeRank[providerScope] <= instanceScopeRank[requiredScope];
}

/**
 * 校验能力引用的绑定数量、基数与实例作用域，返回解析后的 port 提供者。
 * 缺失必需能力、基数冲突和作用域不兼容都给出带消费方与能力 ID 的错误。
 */
export function resolveCapabilityUse(
  ref: CapabilityRef,
  providersByCapability: ReadonlyMap<CapabilityId, readonly CapabilityProvider[]>,
  consumer: CapabilityConsumer,
  realm: Realm,
): ResolvedRequirement {
  const providers = providersByCapability.get(ref.capability) ?? [];
  const details: { [key: string]: Json } = {
    capability: ref.capability,
    cardinality: ref.cardinality,
    instanceScope: ref.instanceScope,
    realm,
  };
  if (consumer.kind === "host") {
    details["source"] = "host";
  } else {
    details["moduleId"] = consumer.moduleId;
  }
  const owner = consumer.kind === "host" ? "宿主" : `模块 ${consumer.moduleId ?? "?"}`;

  if (providers.length === 0) {
    if (ref.cardinality === "optional") {
      return {
        capability: ref.capability,
        cardinality: ref.cardinality,
        instanceScope: ref.instanceScope,
        providers: [],
      };
    }
    throw new DomainError("assembly-incompatible", `能力 ${ref.capability} 缺少必需的绑定实现（${owner}）`, { details });
  }
  if (ref.cardinality === "exactly-one" && providers.length !== 1) {
    throw new DomainError(
      "capability-conflict",
      `能力 ${ref.capability} 声明为 exactly-one，但装配绑定了 ${providers.length} 个实现（${owner}）`,
      {
        details: { ...details, providerModuleIds: providers.map((provider) => provider.definition.id) },
      },
    );
  }
  if (ref.cardinality === "optional" && providers.length > 1) {
    throw new DomainError(
      "capability-conflict",
      `能力 ${ref.capability} 声明为 optional，但装配绑定了 ${providers.length} 个实现（${owner}）`,
      {
        details: { ...details, providerModuleIds: providers.map((provider) => provider.definition.id) },
      },
    );
  }

  for (const provider of providers) {
    for (const [scopeSource, providerScope] of [
      ["capability", provider.provided.instanceScope],
      ["definition", provider.definition.instanceScope],
    ] as const) {
      if (!isInstanceScopeCompatible(providerScope, ref.instanceScope)) {
        throw new DomainError(
          "assembly-incompatible",
          `能力 ${ref.capability} 的提供者 ${provider.definition.id} 作用域 ${providerScope} 不能支撑 ${ref.instanceScope}（${owner}）`,
          {
            details: {
              ...details,
              providerModuleId: provider.definition.id,
              providerScope,
              scopeSource,
            },
          },
        );
      }
    }
  }

  return {
    capability: ref.capability,
    cardinality: ref.cardinality,
    instanceScope: ref.instanceScope,
    providers: providers.map((provider) => ({
      moduleId: provider.definition.id,
      version: provider.definition.version,
    })),
  };
}

/** 按提供者声明的基数检查同一能力的绑定数量，避免重复实现盖掉独占能力。 */
export function validateBindingCardinality(
  providersByCapability: ReadonlyMap<CapabilityId, readonly CapabilityProvider[]>,
  realm: Realm,
): void {
  for (const [capability, providers] of providersByCapability) {
    const cardinalities = new Set(providers.map((provider) => provider.provided.cardinality));
    if (cardinalities.size > 1) {
      throw new DomainError("assembly-incompatible", `能力 ${capability} 的多个实现声明了不同基数`, {
        details: {
          capability,
          realm,
          cardinalities: [...cardinalities],
          providerModuleIds: providers.map((provider) => provider.definition.id),
        },
      });
    }
    const cardinality = providers[0]?.provided.cardinality;
    if (cardinality === "exactly-one" && providers.length !== 1) {
      throw new DomainError("capability-conflict", `能力 ${capability} 是独占能力，但装配绑定了 ${providers.length} 个实现`, {
        details: {
          capability,
          realm,
          cardinality,
          providerModuleIds: providers.map((provider) => provider.definition.id),
        },
      });
    }
    if (cardinality === "optional" && providers.length > 1) {
      throw new DomainError("capability-conflict", `能力 ${capability} 最多绑定一个实现，实际绑定了 ${providers.length} 个`, {
        details: {
          capability,
          realm,
          cardinality,
          providerModuleIds: providers.map((provider) => provider.definition.id),
        },
      });
    }
  }
}
