/**
 * 加载并解析 server 装配：严格读取装配描述符，按绑定合并模块默认配置并计算 kernel 规范化摘要。
 * 依赖 yaml、契约 schema、kernel 摘要函数与组合根模块定义；不启动模块、不打开存储。
 * 禁止接受任意路径、未登记模块，也禁止用模块 ID、原始 JSON.stringify 或截断摘要代替规范化哈希。
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  assemblyDescriptorSchema,
  type AssemblyDescriptor,
  type CapabilityRef,
  type Json,
  type ModuleDefinition,
  type ModuleRef,
  type ResolvedModuleSet,
} from "@ai-npc/contracts";
import {
  computeAssemblyHash,
  computeCatalogHash,
  computeConfigHash,
  createModuleRegistry,
  type CanonicalHasher,
  type PlannedModule,
  type ResolvedRealmPlan,
} from "@ai-npc/kernel";
import { canonicalHasher } from "../host-services";

/** 读取已登记装配；未知 ref 直接失败。 */
export function loadAssembly(ref: string): AssemblyDescriptor {
  const text = (() => {
    switch (ref) {
      case "local-slg-standard-v1":
        return readFileSync("config/assemblies/local-slg-standard-v1.yaml", "utf8");
      case "local-slg-escalating-v1":
        return readFileSync("config/assemblies/local-slg-escalating-v1.yaml", "utf8");
      default:
        throw new Error(`未知 server 装配: ${ref}`);
    }
  })();
  return assemblyDescriptorSchema.parse(parse(text));
}

function configObject(value: Json, label: string): { readonly [key: string]: Json } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是配置对象`);
  }
  return value as { readonly [key: string]: Json };
}

/**
 * 合并模块定义声明的默认值与装配配置块，得到冻结进 manifest 的有效配置。
 * 不静默丢弃装配声明的键：即使模块尚未声明该键，也保留在有效配置中并参与摘要。
 */
function resolveBindingConfig(
  definition: ModuleDefinition,
  assembly: AssemblyDescriptor,
  configRef: string | null,
): Json {
  const defaults =
    definition.defaults === undefined
      ? {}
      : configObject(definition.defaults, `模块 ${definition.id} 的 defaults`);
  if (configRef === null) {
    return { ...defaults };
  }
  const raw = assembly.configs[configRef];
  if (raw === undefined) {
    throw new Error(`模块 ${definition.id} 引用了不存在的配置块 ${configRef}`);
  }
  return { ...defaults, ...configObject(raw, `配置块 ${configRef}`) };
}

/** 一个 server 装配的解析结果：会话握手用的模块集、实例计划与两类规范化摘要。 */
export interface ResolvedServerAssembly {
  readonly plan: ResolvedRealmPlan;
  readonly modules: ResolvedModuleSet;
  readonly assemblyHash: string;
  readonly catalogHash: string;
}

/**
 * 按装配绑定解析 server 模块集与实例计划，并用 kernel 摘要函数计算配置、目录与装配哈希。
 * 无 Agent 槽位时 plan.agentSlots 为空，宿主据此跳过 profile、toolset 与模型布局解析。
 */
export async function resolveServerAssembly(
  assembly: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
  hash: CanonicalHasher = canonicalHasher,
): Promise<ResolvedServerAssembly> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const planned = new Map<string, PlannedModule>();
  const capabilities: CapabilityRef[] = [];
  const capabilityKeys = new Set<string>();
  for (const binding of assembly.realms.server.bindings) {
    const definition = byId.get(binding.moduleId);
    if (definition === undefined) {
      throw new Error(`装配引用未登记模块: ${binding.moduleId}`);
    }
    if (!definition.provides.some((provided) => provided.capability === binding.capability)) {
      throw new Error(`模块 ${definition.id} 未声明提供能力 ${binding.capability}`);
    }
    const existing = planned.get(definition.id);
    if (existing !== undefined) {
      if (existing.configRef !== binding.configRef) {
        throw new Error(`模块 ${definition.id} 被多个能力绑定使用了不同配置块`);
      }
    } else {
      planned.set(definition.id, {
        moduleId: definition.id,
        version: definition.version,
        apiVersion: definition.apiVersion,
        kind: definition.kind,
        instanceScope: definition.instanceScope,
        definition,
        configRef: binding.configRef,
        config: resolveBindingConfig(definition, assembly, binding.configRef),
        requires: [],
      });
    }
    for (const provided of definition.provides) {
      const key = `${provided.capability}:${provided.instanceScope}:${provided.cardinality}`;
      if (!capabilityKeys.has(key)) {
        capabilityKeys.add(key);
        capabilities.push(provided);
      }
    }
  }

  const registry = createModuleRegistry();
  for (const definition of definitions) {
    registry.register(definition);
  }
  const catalog = registry.snapshot();
  const plan: ResolvedRealmPlan = {
    assemblyId: assembly.assemblyId,
    realm: "server",
    modules: [...planned.values()],
    agentSlots: assembly.realms.server.agentSlots ?? {},
  };
  const modules: ModuleRef[] = [];
  for (const module of plan.modules) {
    modules.push({
      moduleId: module.moduleId,
      version: module.version,
      apiVersion: module.apiVersion,
      configHash: await computeConfigHash(module.config, hash),
    });
  }
  const assemblyHash = await computeAssemblyHash({ assembly, realm: "server", plan, hash });
  return {
    plan,
    modules: {
      realm: "server",
      protocolVersion: "1",
      modules,
      capabilities,
      assemblyHash,
    },
    assemblyHash,
    catalogHash: await computeCatalogHash(catalog, hash),
  };
}

/** 会话握手与装配测试只需要的模块集视图。 */
export async function resolveServerModules(
  assembly: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
): Promise<ResolvedModuleSet> {
  return (await resolveServerAssembly(assembly, definitions)).modules;
}
