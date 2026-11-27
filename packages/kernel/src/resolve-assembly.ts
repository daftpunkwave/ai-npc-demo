/**
 * 按装配描述符与已注册模块目录解析一个 realm 的实例计划：校验模块、realm、能力绑定、
 * 能力命名空间、实例作用域与能力依赖闭包，合并部署期配置覆盖，输出依赖拓扑顺序的模块配置与 port 装配关系。
 * 依赖公共契约的模块与装配类型、DomainError，以及本包 descriptor-constraints、registry、resolve-config、capability-requirements。
 * 禁止创建实例或存储/模型/网络资源，也禁止在多个候选实现之间静默挑选或忽略降级。
 */
import {
  DomainError,
  agentSlots as agentSlotNames,
  capabilityIdSchema,
  isSupportedModuleApiVersion,
  type AgentSlot,
  type AssemblyDescriptor,
  type CapabilityBinding,
  type CapabilityId,
  type CapabilityRef,
  type InstanceScope,
  type Json,
  type ModuleDefinition,
  type ModuleKind,
  type Realm,
} from "@world-prism/contracts";
import { REALM_NAMESPACES, leadingNamespace } from "./descriptor-constraints";
import type { CatalogSnapshot } from "./registry";
import { resolveModuleConfig } from "./resolve-config";
import {
  resolveCapabilityUse,
  validateBindingCardinality,
  type ResolvedRequirement,
} from "./capability-requirements";

/** 解析一个 realm 的输入：装配描述符、目标 realm、已注册目录与宿主固定必需能力。 */
export interface ResolveRealmInput {
  readonly assembly: AssemblyDescriptor;
  readonly realm: Realm;
  readonly catalog: CatalogSnapshot;
  readonly requiredCapabilities?: readonly CapabilityRef[];
  /**
   * 部署期配置覆盖：按模块 ID 并入装配配置块，再走同一 config schema 校验。
   * 只用于宿主启动参数（数据目录、监听端口等）；摘要与握手仍以装配声明为准。
   */
  readonly configOverrides?: Readonly<Record<string, Json>>;
}

/** 计划中的单个模块实例：已解析配置、port 装配关系与描述符身份。 */
export interface PlannedModule {
  readonly moduleId: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly kind: ModuleKind;
  readonly instanceScope: InstanceScope;
  readonly definition: ModuleDefinition;
  readonly configRef: string | null;
  readonly config: Json;
  readonly requires: readonly ResolvedRequirement[];
}

/** 一个 realm 的完整实例计划；modules 已按“提供者先于消费者”的拓扑顺序排列。 */
export interface ResolvedRealmPlan {
  readonly assemblyId: string;
  readonly realm: Realm;
  readonly modules: readonly PlannedModule[];
  readonly agentSlots: Readonly<Partial<Record<AgentSlot, readonly string[]>>>;
}

interface BindingResolution {
  readonly binding: CapabilityBinding;
  readonly definition: ModuleDefinition;
  readonly provided: CapabilityRef;
  readonly configRef: string | null;
  readonly config: Json;
}

interface ModuleConfigResolution {
  readonly definition: ModuleDefinition;
  readonly configRef: string | null;
  readonly config: Json;
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
function isJsonObject(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把部署期覆盖并入绑定配置块：覆盖键优先于装配声明，但合并结果仍交给模块 config schema 严格校验。
 * 非对象覆盖与覆盖未装配模块都在这里失败，避免宿主静默忽略启动参数。
 */
function mergeConfigOverride(
  definition: ModuleDefinition,
  configRef: string | null,
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  raw: Json | undefined,
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  override: Json | undefined,
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
): Json | undefined {
  if (override === undefined) {
    return raw;
  }
  if (!isJsonObject(override)) {
    throw new DomainError("assembly-incompatible", `模块 ${definition.id} 的部署配置覆盖必须是 JSON 对象`, {
      details: { moduleId: definition.id, configRef },
    });
  }
  if (raw === undefined) {
    return override;
  }
  if (!isJsonObject(raw)) {
    return raw;
  }
  return { ...raw, ...override };
}

function indexCatalog(catalog: CatalogSnapshot): Map<string, ModuleDefinition[]> {
  const byModuleId = new Map<string, ModuleDefinition[]>();
  for (const definition of catalog) {
    const versions = byModuleId.get(definition.id);
    if (versions === undefined) {
      byModuleId.set(definition.id, [definition]);
    } else {
      versions.push(definition);
    }
  }
  for (const versions of byModuleId.values()) {
    versions.sort((left, right) => compareText(left.version, right.version));
  }
  return byModuleId;
}

function pickDefinition(
  catalogIndex: ReadonlyMap<string, ModuleDefinition[]>,
  moduleId: string,
  realm: Realm,
  locator: Readonly<Record<string, Json>>,
): ModuleDefinition {
  const versions = catalogIndex.get(moduleId) ?? [];
  if (versions.length === 0) {
    throw new DomainError("module-missing", `模块 ${moduleId} 未在 ${realm} realm 的目录中注册`, {
      details: { ...locator, moduleId, realm },
    });
  }
  const definition = versions[0];
  if (definition === undefined || versions.length > 1) {
    throw new DomainError("assembly-incompatible", `模块 ${moduleId} 存在多个已注册版本，装配无法唯一确定`, {
      details: { ...locator, moduleId, versions: versions.map((versioned) => versioned.version) },
    });
  }
  if (definition.realm !== realm) {
    throw new DomainError("realm-violation", `模块 ${definition.id} 属于 ${definition.realm} realm，不能装配到 ${realm}`, {
      details: { ...locator, moduleId: definition.id, moduleRealm: definition.realm, realm },
    });
  }
  if (!isSupportedModuleApiVersion(definition.apiVersion)) {
    throw new DomainError(
      "assembly-incompatible",
      `模块 ${definition.id} 的契约版本 ${definition.apiVersion} 不受当前宿主支持`,
      {
        details: {
          ...locator,
          moduleId: definition.id,
          apiVersion: definition.apiVersion,
          realm,
        },
      },
    );
  }
  if (realm === "server" && definition.requiresRemote.length > 0) {
    throw new DomainError("assembly-incompatible", `模块 ${definition.id} 声明了仅浏览器使用的远端能力，不能装入服务端 realm`, {
      details: { ...locator, moduleId: definition.id, requiresRemote: [...definition.requiresRemote] },
    });
  }
  return definition;
}

/**
 * 槽位到能力 ID 的映射：toolView 的能力族与槽位名不同，其余槽位与能力族同名。
 * 这里只表达「候选模块必须为自己声明提供该能力」，不校验具体实现版本。
 */
function capabilityOfAgentSlot(slot: AgentSlot): CapabilityId {
  return capabilityIdSchema.parse(slot === "toolView" ? "agent.tool-view" : `agent.${slot}`);
}

/** 解析 Agent 槽位候选模块；候选不进入本 realm 的实例计划，但其依赖必须满足闭包。 */
function resolveAgentSlotCandidates(
  assembly: AssemblyDescriptor,
  realm: Realm,
  catalogIndex: ReadonlyMap<string, ModuleDefinition[]>,
): {
  readonly candidates: Map<string, ModuleDefinition>;
  readonly slots: Partial<Record<AgentSlot, readonly string[]>>;
} {
  const candidates = new Map<string, ModuleDefinition>();
  const slots: Partial<Record<AgentSlot, readonly string[]>> = {};
  if (realm !== "server") {
    return { candidates, slots };
  }
  const declared = assembly.realms.server.agentSlots;
  if (declared === undefined) {
    return { candidates, slots };
  }
  for (const slot of agentSlotNames) {
    // eslint-disable-next-line security/detect-object-injection -- 槽位、realm 与配置引用来自固定清单与受限枚举。
    const moduleIds = declared[slot];
    if (moduleIds === undefined) {
      continue;
    }
    if (new Set(moduleIds).size !== moduleIds.length) {
      throw new DomainError("assembly-incompatible", `agentSlots.${slot} 中存在重复的模块 ID`, {
        details: { slot, moduleIds: [...moduleIds] },
      });
    }
    for (const moduleId of moduleIds) {
      const definition = pickDefinition(catalogIndex, moduleId, realm, { slot });
      // 槽位候选会按槽位创建为 Agent 级实例，并由运行时按槽位能力取用；
      // 作用域或能力不匹配时在装配解析阶段失败，避免预检通过而 run 启动必然失败。
      const expectedCapability = capabilityOfAgentSlot(slot);
      if (definition.instanceScope !== "agent") {
        throw new DomainError(
          "assembly-incompatible",
          `agentSlots.${slot} 的模块 ${definition.id} 的实例作用域为 ${definition.instanceScope}，槽位只接受 agent 作用域`,
          {
            details: {
              slot,
              moduleId: definition.id,
              expectedInstanceScope: "agent",
              instanceScope: definition.instanceScope,
            },
          },
        );
      }
      if (!definition.provides.some((provided) => provided.capability === expectedCapability)) {
        throw new DomainError(
          "assembly-incompatible",
          `agentSlots.${slot} 的模块 ${definition.id} 未声明提供槽位能力 ${expectedCapability}`,
          {
            details: {
              slot,
              moduleId: definition.id,
              expectedCapability,
              providedCapabilities: definition.provides.map((provided) => provided.capability),
            },
          },
        );
      }
      candidates.set(definition.id, definition);
    }
    // eslint-disable-next-line security/detect-object-injection -- 槽位、realm 与配置引用来自固定清单与受限枚举。
    slots[slot] = [...moduleIds];
  }
  return { candidates, slots };
}

/** 在剩余节点中沿依赖边找出一个具体环，供错误信息定位。 */
function findDependencyCycle(
  remaining: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const start = [...remaining].sort(compareText)[0];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
  if (start === undefined) {
    return [];
  }
  const path: string[] = [];
  const positions = new Map<string, number>();
  let current: string | undefined = start;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 循环内会重新给 current 赋值，运行期仍可能为 undefined；类型收窄在循环边界失效。
  while (current !== undefined) {
    const position = positions.get(current);
    if (position !== undefined) {
      return [...path.slice(position), current];
    }
    positions.set(current, path.length);
    path.push(current);
    current = [...(dependencies.get(current) ?? [])].filter((dependency) => remaining.has(dependency)).sort(compareText)[0];
  }
  return path;
}

/**
 * 对能力依赖图做拓扑排序：被依赖的提供者先输出，同层按模块 ID 稳定排序。
 * 若仍有节点无法出队，说明依赖成环，错误中给出具体环路而不是静默截断。
 */
function sortByDependencies(
  nodes: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const remaining = new Set(nodes);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((node) => [...(dependencies.get(node) ?? [])].every((dependency) => !remaining.has(dependency)))
      .sort(compareText);
    if (ready.length === 0) {
      const cycle = findDependencyCycle(remaining, dependencies);
      throw new DomainError("assembly-incompatible", `能力依赖存在环：${cycle.join(" -> ")}`, {
        details: { cycle: [...cycle] },
      });
    }
    for (const node of ready) {
      ordered.push(node);
      remaining.delete(node);
    }
  }
  return ordered;
}

/** 解析一个 realm 的装配：校验绑定与配置、能力闭包、实例作用域与依赖环，输出实例计划。 */
export function resolveRealmPlan(input: ResolveRealmInput): ResolvedRealmPlan {
  const { assembly, realm } = input;
  const catalogIndex = indexCatalog(input.catalog);
  // eslint-disable-next-line security/detect-object-injection -- 槽位、realm 与配置引用来自固定清单与受限枚举。
  const bindings = assembly.realms[realm].bindings;
  const moduleConfigs = new Map<string, ModuleConfigResolution>();
  const bindingResolutions = new Map<string, BindingResolution>();
  const providersByCapability = new Map<CapabilityId, BindingResolution[]>();

  for (const binding of bindings) {
    // 能力图只能由本 realm 命名空间的能力组成：跨 realm 的绑定即使模块恰好声明了该能力，
    // 也会让浏览器段冒充服务端能力（或反之），必须在解析阶段拒绝，而不是只靠离线目录检查兜底。
    // eslint-disable-next-line security/detect-object-injection -- realm 来自 zod 受限枚举。
    if (!REALM_NAMESPACES[realm].includes(leadingNamespace(binding.capability))) {
      throw new DomainError("realm-violation", `能力 ${binding.capability} 不属于 ${realm} realm 的能力命名空间`, {
        details: { capability: binding.capability, moduleId: binding.moduleId, realm },
      });
    }
    if (binding.fallbackModuleIds !== undefined && binding.fallbackModuleIds.length > 0) {
      throw new DomainError("assembly-incompatible", `能力 ${binding.capability} 的 fallback 绑定尚未支持，必须显式指定唯一实现`, {
        details: {
          capability: binding.capability,
          moduleId: binding.moduleId,
          fallbackModuleIds: [...binding.fallbackModuleIds],
        },
      });
    }
    const definition = pickDefinition(catalogIndex, binding.moduleId, realm, { capability: binding.capability });
    const provided = definition.provides.find((item) => item.capability === binding.capability);
    if (provided === undefined) {
      throw new DomainError("assembly-incompatible", `模块 ${definition.id} 未声明提供能力 ${binding.capability}`, {
        details: {
          capability: binding.capability,
          moduleId: definition.id,
          providedCapabilities: definition.provides.map((item) => item.capability),
        },
      });
    }
    const bindingKey = `${binding.capability}\u0000${definition.id}`;
    if (bindingResolutions.has(bindingKey)) {
      throw new DomainError("capability-conflict", `能力 ${binding.capability} 重复绑定了模块 ${definition.id}`, {
        details: { capability: binding.capability, moduleId: definition.id, realm },
      });
    }

    const configRef = binding.configRef;
    let moduleConfig = moduleConfigs.get(definition.id);
    if (moduleConfig === undefined) {
      // eslint-disable-next-line security/detect-object-injection -- 槽位、realm 与配置引用来自固定清单与受限枚举。
      const rawConfig = configRef === null ? undefined : assembly.configs[configRef];
      if (configRef !== null && rawConfig === undefined) {
        throw new DomainError("assembly-incompatible", `模块 ${definition.id} 引用了不存在的配置块 ${configRef}`, {
          details: { capability: binding.capability, moduleId: definition.id, configRef },
        });
      }
      const effectiveConfig = mergeConfigOverride(
        definition,
        configRef,
        rawConfig,
        input.configOverrides?.[definition.id],
      );
      moduleConfig = { definition, configRef, config: resolveModuleConfig(definition, effectiveConfig, configRef) };
      moduleConfigs.set(definition.id, moduleConfig);
    } else if (moduleConfig.configRef !== configRef) {
      throw new DomainError("assembly-incompatible", `模块 ${definition.id} 被多个能力绑定使用了不同配置块`, {
        details: {
          capability: binding.capability,
          moduleId: definition.id,
          firstConfigRef: moduleConfig.configRef,
          secondConfigRef: configRef,
        },
      });
    }

    const resolution: BindingResolution = {
      binding,
      definition,
      provided,
      configRef,
      config: moduleConfig.config,
    };
    bindingResolutions.set(bindingKey, resolution);
    const group = providersByCapability.get(binding.capability);
    if (group === undefined) {
      providersByCapability.set(binding.capability, [resolution]);
    } else {
      group.push(resolution);
    }
  }

  if (input.configOverrides !== undefined) {
    for (const moduleId of Object.keys(input.configOverrides)) {
      if (!moduleConfigs.has(moduleId)) {
        throw new DomainError("assembly-incompatible", `部署配置覆盖引用了未装配的模块 ${moduleId}`, {
          details: { moduleId, realm },
        });
      }
    }
  }

  validateBindingCardinality(providersByCapability, realm);
  const agentSlotCandidates = resolveAgentSlotCandidates(assembly, realm, catalogIndex);

  const consumerDefinitions = new Map<string, ModuleDefinition>();
  for (const moduleConfig of moduleConfigs.values()) {
    consumerDefinitions.set(moduleConfig.definition.id, moduleConfig.definition);
  }
  for (const candidate of agentSlotCandidates.candidates.values()) {
    consumerDefinitions.set(candidate.id, candidate);
  }

  const requirementsByModule = new Map<string, readonly ResolvedRequirement[]>();
  for (const definition of consumerDefinitions.values()) {
    const requirements = definition.requires.map((ref) =>
      resolveCapabilityUse(ref, providersByCapability, { kind: "module", moduleId: definition.id }, realm),
    );
    requirementsByModule.set(definition.id, requirements);
  }
  for (const ref of input.requiredCapabilities ?? []) {
    resolveCapabilityUse(ref, providersByCapability, { kind: "host", moduleId: null }, realm);
  }

  const nodes = new Set(consumerDefinitions.keys());
  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const moduleId of nodes) {
    const providers = new Set<string>();
    for (const requirement of requirementsByModule.get(moduleId) ?? []) {
      for (const provider of requirement.providers) {
        if (nodes.has(provider.moduleId)) {
          providers.add(provider.moduleId);
        }
      }
    }
    dependencies.set(moduleId, providers);
  }
  const orderedModuleIds = sortByDependencies(nodes, dependencies);

  const plannedModules: PlannedModule[] = [];
  for (const moduleId of orderedModuleIds) {
    const moduleConfig = moduleConfigs.get(moduleId);
    if (moduleConfig === undefined) {
      continue;
    }
    const definition = moduleConfig.definition;
    plannedModules.push({
      moduleId: definition.id,
      version: definition.version,
      apiVersion: definition.apiVersion,
      kind: definition.kind,
      instanceScope: definition.instanceScope,
      definition,
      configRef: moduleConfig.configRef,
      config: moduleConfig.config,
      requires: requirementsByModule.get(definition.id) ?? [],
    });
  }

  return {
    assemblyId: assembly.assemblyId,
    realm,
    modules: plannedModules,
    agentSlots: agentSlotCandidates.slots,
  };
}
