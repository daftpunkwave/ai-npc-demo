/**
 * 加载并校验 server 装配与在线 RunSpec；宿主只经此文件读取配置。
 * 依赖 yaml、契约 schema 与组合根模块定义；不启动模块、不打开存储。
 * 禁止接受任意路径或未登记模块。
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

/** 解析 RunSpec；首版只要求可解析对象，字段由后续评估步骤扩展。 */
export function loadRunSpec(ref: string): Json {
  if (ref !== "online-default") {
    throw new Error(`未知 RunSpec: ${ref}`);
  }
  const value = parse(readFileSync("config/runs/online-default.yaml", "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("online-default RunSpec 不是对象");
  }
  return value as Json;
}

/** 把装配绑定解析为会话可见的已解析模块集。 */
export function resolveServerModules(
  assembly: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
): ResolvedModuleSet {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const modules: ModuleRef[] = [];
  const capabilities: CapabilityRef[] = [];
  const capabilityKeys = new Set<string>();
  for (const binding of assembly.realms.server.bindings) {
    const definition = byId.get(binding.moduleId);
    if (definition === undefined) {
      throw new Error(`装配引用未登记模块: ${binding.moduleId}`);
    }
    modules.push({
      moduleId: definition.id,
      version: definition.version,
      apiVersion: definition.apiVersion,
      configHash: binding.configRef ?? "default",
    });
    for (const provided of definition.provides) {
      const key = `${provided.capability}:${provided.instanceScope}:${provided.cardinality}`;
      if (!capabilityKeys.has(key)) {
        capabilityKeys.add(key);
        capabilities.push(provided);
      }
    }
  }
  return {
    realm: "server",
    protocolVersion: "1",
    modules,
    capabilities,
    assemblyHash: assembly.assemblyId,
  };
}
