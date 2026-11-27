/**
 * 还原在线存档已冻结的历史模块目录与服务端装配，并让浏览器段与历史服务端装配保持一致。
 * 使用旧目录的精确摘要和模型段落判断历史装配形态，完整清单在启动时再次复算。
 * 禁止修改存档、替换 provider 或接受未经确认的历史目录。
 */
import type { AssemblyDescriptor, ModuleDefinition } from "@world-prism/contracts";
import { computeCatalogHash, createModuleRegistry } from "@world-prism/kernel";
import { canonicalHasher } from "../host-services";
import type { FrozenManifestFacts } from "./manifest";
import {
  browserModuleDefinitions,
  serverAgentModuleDefinitions,
  serverLiveModelTransportDefinitions,
  serverModelModuleDefinitions,
} from "./module-catalog";

type RealmBindings = AssemblyDescriptor["realms"]["client"];

/**
 * 去掉浏览器段里 requiresRemote 依赖已移除服务端能力的绑定。
 * 历史装配只回退 server 段；沿用当前浏览器段时，依赖新增服务端能力的页面（如模型挂载页依赖 agent.model-pool）
 * 在历史组合里没有远端提供者，会话装配会按远端能力缺口拒绝启动，旧在线分支就无法恢复。
 */
function withoutRemovedRemoteDependents(realm: RealmBindings, removedCapabilities: ReadonlySet<string>): RealmBindings {
  const remoteOf = new Map(browserModuleDefinitions.map(({ id, requiresRemote }) => [id, requiresRemote]));
  return {
    bindings: realm.bindings.filter(({ moduleId }) =>
      !(remoteOf.get(moduleId) ?? []).some((capability) => removedCapabilities.has(capability))),
  };
}

export async function resolveFrozenAssembly(
  current: AssemblyDescriptor,
  definitions: readonly ModuleDefinition[],
  facts: FrozenManifestFacts,
): Promise<{ readonly assembly: AssemblyDescriptor; readonly definitions: readonly ModuleDefinition[]; readonly legacyDecision: boolean }> {
  const beforeModelPool = facts.hasAgentSlots ? serverModelModuleDefinitions : serverAgentModuleDefinitions;
  for (const removed of [serverLiveModelTransportDefinitions, beforeModelPool]) {
    const excluded = new Set<string>(removed.map(({ id }) => id));
    const historical = definitions.filter(({ id }) => !excluded.has(id));
    if (historical.length === definitions.length) continue;
    const registry = createModuleRegistry();
    for (const definition of historical) registry.register(definition);
    if (await computeCatalogHash(registry.snapshot(), canonicalHasher) !== facts.catalogHash) continue;

    const { bindings, agentSlots } = current.realms.server;
    const historicalBindings = bindings.filter(({ capability, moduleId }) => !excluded.has(moduleId) &&
      (facts.hasModels || (capability !== "agent.model-pool" && capability !== "platform.budget")))
      .map((binding) => binding.capability === "platform.secrets" && binding.configRef === "model-secrets"
        ? { ...binding, configRef: null } : binding);
    const server = facts.hasAgentSlots && agentSlots !== undefined
      ? { bindings: historicalBindings, agentSlots: {
        ...agentSlots,
        decision: agentSlots.decision?.filter((id) => !excluded.has(id) && (facts.hasModels || id !== "agent.decision.model")),
      } }
      : { bindings: historicalBindings };
    const removedCapabilities = new Set(bindings.map(({ capability }) => capability)
      .filter((capability) => !historicalBindings.some((binding) => binding.capability === capability)));
    const realms = {
      server,
      client: withoutRemovedRemoteDependents(current.realms.client, removedCapabilities),
      console: withoutRemovedRemoteDependents(current.realms.console, removedCapabilities),
    };
    return {
      assembly: { ...current, realms }, definitions: historical,
      legacyDecision: facts.hasAgentSlots && removed === beforeModelPool,
    };
  }
  return { assembly: current, definitions, legacyDecision: false };
}
