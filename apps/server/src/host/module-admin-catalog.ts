/**
 * 核心职责：把装配目录解析成模块管理端可用的目录快照（目录哈希、模块定义与各装配的已解析模块集）。
 * 交互契约：输入装配目录、模块定义与内容包，输出 `moduleAdmin.bind` 需要的载荷；
 * 同一份内容包与模块定义在全部装配间复用，解析结果只描述配置，不启动模块、不打开存储。
 * 约束与禁忌：不写死装配文件名、不跳过解析失败的装配，也不把服务端配置下发到浏览器 realm。
 */
import type { AssemblyDescriptor, ModuleDefinition } from "@ai-npc/contracts";
import type { ContentPack } from "@ai-npc/experiment";
import { computeCatalogHash, createModuleRegistry } from "@ai-npc/kernel";
import { canonicalHasher } from "../host-services";
import { resolveServerAssembly, resolveSessionAssemblies } from "./assembly";
import { allModuleDefinitions, serverModuleDefinitions } from "./module-catalog";

/** 单个仓库装配的目录条目；`resolved` 只含公开模块集，不含模块实例。 */
export interface AdminCatalogAssembly {
  readonly source: "repo";
  readonly descriptor: AssemblyDescriptor;
  readonly resolved: {
    readonly server: Awaited<ReturnType<typeof resolveServerAssembly>>["modules"];
    readonly client: Awaited<ReturnType<typeof resolveSessionAssemblies>>["client"];
    readonly console: Awaited<ReturnType<typeof resolveSessionAssemblies>>["console"];
  };
}

/** 模块管理端绑定的目录快照。 */
export interface ModuleAdminCatalog {
  readonly catalogHash: string;
  readonly definitions: readonly ModuleDefinition[];
  readonly assemblies: readonly AdminCatalogAssembly[];
}

/** 逐装配解析服务端与会话模块集，并计算模块目录哈希；装配顺序沿用目录读取顺序。 */
export async function resolveModuleAdminCatalog(input: {
  readonly assemblies: readonly AssemblyDescriptor[];
  readonly content: ContentPack;
}): Promise<ModuleAdminCatalog> {
  const registry = createModuleRegistry();
  for (const definition of allModuleDefinitions) {
    registry.register(definition);
  }
  const catalogHash = await computeCatalogHash(registry.snapshot(), canonicalHasher);
  const assemblies: AdminCatalogAssembly[] = [];
  for (const assembly of input.assemblies) {
    const server = await resolveServerAssembly(assembly, serverModuleDefinitions, { content: input.content });
    const browser = await resolveSessionAssemblies(assembly, allModuleDefinitions);
    assemblies.push({
      source: "repo",
      descriptor: assembly,
      resolved: { server: server.modules, client: browser.client, console: browser.console },
    });
  }
  return { catalogHash, definitions: allModuleDefinitions, assemblies };
}
