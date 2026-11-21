/**
 * 启动在线分支的调度与工具 provider，并预检名册的实际工具绑定。
 * 使用已解析计划及已启动的依赖 provider，返回本次 run 拥有的实例。
 * 启动失败时释放实例，避免保存一份无法启动的在线配置。
 */
import type { HostServices, ModuleScope } from "@ai-npc/contracts";
import { startInstances, type ResolvedRealmPlan, type RunningInstance, type StartedInstances } from "@ai-npc/kernel";
import type { AgentToolsPort, SchedulingPort } from "@ai-npc/module-sdk";
import type { AgentConfiguration } from "./agent-configuration";
import { plannedModuleForCapability, serverAgentRequiredCapabilities } from "./module-catalog";

export interface AgentRunModules {
  readonly started: StartedInstances;
  readonly scheduling: SchedulingPort;
  readonly tools: AgentToolsPort;
  readonly maxConcurrentTurns: number;
  readonly patrolHour?: number;
}

export function agentRunModuleIds(plan: ResolvedRealmPlan): ReadonlySet<string> {
  return new Set(serverAgentRequiredCapabilities.map(({ capability }) => plannedModuleForCapability(plan, capability).moduleId));
}

export async function startAgentRunModules(input: {
  readonly plan: ResolvedRealmPlan;
  readonly configuration: AgentConfiguration;
  readonly host: HostServices;
  readonly scope: ModuleScope;
  readonly running: readonly RunningInstance[];
}): Promise<AgentRunModules> {
  const { plan, configuration, host, scope, running } = input;
  const ids = agentRunModuleIds(plan);
  const schedule = plannedModuleForCapability(plan, "agent.scheduling");
  const catalog = plannedModuleForCapability(plan, "agent.tools");
  const settings = configuration.schedulingConfig as { maxConcurrentTurns?: number; patrolHour?: number };
  const { maxConcurrentTurns, patrolHour } = settings;
  if (typeof maxConcurrentTurns !== "number" || !Number.isSafeInteger(maxConcurrentTurns) || maxConcurrentTurns < 1) {
    throw new Error("Scheduling configuration requires a positive maxConcurrentTurns");
  }
  const started = await startInstances({
    ...plan,
    modules: plan.modules.filter(({ moduleId }) => ids.has(moduleId))
      .map((module) => module.moduleId === schedule.moduleId ? { ...module, config: configuration.schedulingConfig } : module),
  }, { host, scope, running });
  try {
    const tools = started.instances.find(({ moduleId }) => moduleId === catalog.moduleId)?.port as AgentToolsPort | undefined;
    const scheduling = started.instances.find(({ moduleId }) => moduleId === schedule.moduleId)?.port as SchedulingPort | undefined;
    if (typeof tools?.bindAgentToolset !== "function" || typeof scheduling?.plan !== "function") {
      throw new Error("Agent run provider did not expose its port");
    }
    for (const [agentId, toolset] of configuration.toolsets) tools.bindAgentToolset({ ...toolset, agentId });
    return { started, tools, scheduling, maxConcurrentTurns, ...(patrolHour === undefined ? {} : { patrolHour }) };
  } catch (error) {
    try {
      await started.dispose();
    } catch (cleanupError) {
      host.logger.error("Agent run module cleanup failed", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
}
