/**
 * 还原在线存档已冻结的历史模块目录与服务端装配。
 * 使用旧目录的精确摘要和模型段落判断历史装配形态，完整清单在启动时再次复算。
 * 禁止修改存档、替换 provider 或接受未经确认的历史目录。
 */
import type { AssemblyDescriptor, ModuleDefinition } from "@ai-npc/contracts";
import { computeCatalogHash, createModuleRegistry } from "@ai-npc/kernel";
import { canonicalHasher } from "../host-services";
import type { FrozenManifestFacts } from "./manifest";
import { serverAgentModuleDefinitions, serverLiveModelTransportDefinitions, serverModelModuleDefinitions } from "./module-catalog";

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
    return {
      assembly: { ...current, realms: { ...current.realms, server } }, definitions: historical,
      legacyDecision: facts.hasAgentSlots && removed === beforeModelPool,
    };
  }
  return { assembly: current, definitions, legacyDecision: false };
}
