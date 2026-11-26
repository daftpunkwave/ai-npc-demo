/**
 * 解析并冻结在线名册实际使用的 Agent 槽位、调度与工具绑定配置。
 * 使用已解析的装配白名单和模块 schema，收敛到同一 run 级调度设置。
 * 不在缺少 Agent 槽位时加载认知配置，不加载模型布局或启动模块。
 */
import { agentSlots, canonicalJson, type Json, type ModuleDefinition } from "@world-prism/contracts";
import {
  applyProfilePatch,
  loadAgentProfile,
  loadAgentToolset,
  profileJson,
  validateProfileSelection,
  type AgentToolset,
  type ConfigLoadContext,
  type ContentPack,
  type ResolvedAgentProfile,
  type Roster,
  type RunSpec,
} from "@world-prism/experiment";
import { resolveModuleConfig } from "@world-prism/kernel";
import { agentModelPoolCapability } from "@world-prism/module-sdk";
import type { ResolvedServerAssembly } from "./assembly";
import { canonicalHasher } from "../host-services";
import { resolveModelConfiguration, type ModelConfiguration } from "./model-configuration";

export interface AgentConfiguration {
  readonly roster: Roster;
  readonly profiles: ReadonlyMap<string, ResolvedAgentProfile>;
  readonly profileHashes: ReadonlyMap<string, string>;
  readonly toolsets: ReadonlyMap<string, AgentToolset>;
  readonly modules: ReadonlyMap<string, ModuleDefinition>;
  readonly schedulingConfig: Json;
  readonly manifest: Json;
  readonly models: ModelConfiguration | null;
  readonly modelAgents: ReadonlySet<string>;
}

export async function resolveAgentConfiguration(input: {
  readonly assembly: ResolvedServerAssembly;
  readonly roster: Roster;
  readonly runSpec: RunSpec;
  readonly loadContext: ConfigLoadContext;
  readonly definitions: readonly ModuleDefinition[];
  readonly content: ContentPack;
  readonly legacyDecision?: boolean;
}): Promise<AgentConfiguration | null> {
  const allowlist = input.assembly.plan.agentSlots;
  if (Object.keys(allowlist).length === 0) return null;
  const profiles = new Map<string, ResolvedAgentProfile>();
  const profileHashes = new Map<string, string>();
  const toolsets = new Map<string, AgentToolset>();
  // 名册里多数身份共享同一 profile 与 toolset 引用：按引用只解析一次，避免逐个 Agent 重走继承链。
  const baseProfiles = new Map<string, ResolvedAgentProfile>();
  const loadedToolsets = new Map<string, AgentToolset>();
  const modules = new Map(input.definitions.map((definition) => [definition.id, definition]));
  const scheduling = input.assembly.plan.modules.find(({ definition }) =>
    definition.provides.some((port) => port.capability === "agent.scheduling"));
  if (scheduling === undefined) throw new Error("Agent assembly has no scheduling provider");
  let schedulingConfig: Json | undefined;
  const manifest: Json[] = [];
  const modelAgents = new Set<string>();

  for (const agent of input.roster.agents) {
    let profile = baseProfiles.get(agent.profileRef);
    if (profile === undefined) {
      profile = loadAgentProfile(agent.profileRef, input.loadContext);
      baseProfiles.set(agent.profileRef, profile);
    }
    if (input.legacyDecision === true && profile.slots.decision?.module === "agent.decision.model") {
      profile = applyProfilePatch(profile, "decision-deterministic", input.loadContext);
    }
    const variant = input.runSpec.variant;
    if (variant !== null && (variant.agentIds === null || variant.agentIds === undefined ||
      variant.agentIds.includes(agent.agentId))) {
      for (const ref of variant.profilePatchRefs) profile = applyProfilePatch(profile, ref, input.loadContext);
    }
    validateProfileSelection(profile, allowlist);
    if (profile.scheduling.module !== scheduling.moduleId) {
      throw new Error(`Profile "${profile.profileId}" selects an unbound scheduling provider`);
    }
    const schedule = resolveModuleConfig(scheduling.definition, profile.scheduling.config, profile.profileId);
    if (schedulingConfig !== undefined && canonicalJson(schedulingConfig) !== canonicalJson(schedule)) {
      throw new Error("Agent profiles require different run scheduling settings");
    }
    schedulingConfig = schedule;
    const selections = { ...profile.slots };
    const slotModules: Json[] = [];
    for (const slot of agentSlots) {
      const selected = profile.slots[slot];
      const definition = selected === undefined ? undefined : modules.get(selected.module);
      const capability = slot === "toolView" ? "agent.tool-view" : `agent.${slot}`;
      if (selected === undefined || definition?.instanceScope !== "agent" ||
        !definition.provides.some((port) => port.capability === capability)) {
        throw new Error(`Profile "${profile.profileId}" does not bind an Agent ${slot} provider`);
      }
      selections[slot] = { module: selected.module, config: resolveModuleConfig(definition, selected.config, profile.profileId) };
      if (slot === "decision" && definition.requires.some(({ capability }) => capability === agentModelPoolCapability)) {
        modelAgents.add(agent.agentId);
      }
      slotModules.push({ moduleId: definition.id, version: definition.version, apiVersion: definition.apiVersion });
    }
    const resolved: ResolvedAgentProfile = {
      ...profile,
      slots: selections,
      failurePolicy: input.runSpec.failurePolicy,
      scheduling: { module: scheduling.moduleId, config: schedule },
    };
    const toolset = loadedToolsets.get(agent.toolsetRef) ?? loadAgentToolset(agent.toolsetRef, input.loadContext);
    loadedToolsets.set(agent.toolsetRef, toolset);
    const source = { profile: profileJson(resolved), slotModules, toolset };
    const profileHash = await canonicalHasher(canonicalJson(source));
    profiles.set(agent.agentId, resolved);
    profileHashes.set(agent.agentId, profileHash);
    toolsets.set(agent.agentId, toolset);
    manifest.push({ agentId: agent.agentId, profileHash, ...source });
  }
  if (schedulingConfig === undefined) throw new Error("Agent assembly requires a nonempty roster");
  const models = await resolveModelConfiguration({
    plan: input.assembly.plan, runSpec: input.runSpec, loadContext: input.loadContext,
    knownAgentIds: input.content.index.agentIds, profiles, modelAgents,
    promptConfig: { templateVersion: input.content.prompts.templateVersion, value: input.content.prompts },
  });
  return { roster: input.roster, profiles, profileHashes, toolsets, modules, schedulingConfig, manifest, models, modelAgents };
}
