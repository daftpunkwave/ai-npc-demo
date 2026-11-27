/**
 * 按优先级、等待老化、冷却与单身份互斥生成有界 turn 计划。
 * 依赖调用方提供的已筛选 trigger 与 Agent 状态。
 * 禁止在暂停态调度普通 trigger，或为非 Agent 控制（human 接管、script 窗口）的身份创建 turn。
 */
import type { AgentTrigger, ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import {
  createStatelessModule,
  type SchedulingInput,
  type SchedulingPort,
} from "@world-prism/module-sdk";
import { schedulingConfigSchema, type SchedulingConfig } from "./definition";

const unrestrictedKinds = new Set(["player-dialogue", "debug", "probe"]);

export function planSchedule(input: SchedulingInput, config: SchedulingConfig): ReturnType<SchedulingPort["plan"]> {
  const agents = new Map(input.agents.map((agent) => [agent.agentId, agent]));
  const triggersByAgent = new Map<string, AgentTrigger[]>();
  for (const trigger of input.triggers) {
    if (trigger.consumedByTurnId !== null) {
      continue;
    }
    const values = triggersByAgent.get(trigger.agentId) ?? [];
    values.push(trigger);
    triggersByAgent.set(trigger.agentId, values);
  }

  const candidates: {
    readonly agentId: string;
    readonly score: number;
    readonly firstTick: number;
    readonly triggers: readonly AgentTrigger[];
  }[] = [];
  for (const [agentId, agentTriggers] of triggersByAgent) {
    const agent = agents.get(agentId);
    if (
      agent === undefined ||
      !agent.active ||
      agent.controllerKind !== "agent" ||
      input.runningTurnAgentIds.includes(agentId)
    ) {
      continue;
    }
    const usable = agentTriggers
      .filter((trigger) => !input.paused || trigger.kind === "debug" || trigger.kind === "probe")
      .sort((left, right) => left.createdTick - right.createdTick);
    if (usable.length === 0) {
      continue;
    }
    const lastTurn = input.lastTurnTickByAgent[agentId];
    const cooldownTicks = lastTurn === undefined ? Number.POSITIVE_INFINITY : input.worldTick - lastTurn;
    const inCooldown = lastTurn !== undefined && cooldownTicks < config.cooldownTicks;
    const eligible = usable.filter((trigger) => !inCooldown || unrestrictedKinds.has(trigger.kind));
    const first = eligible[0];
    if (first === undefined) continue;
    const merged = eligible.slice(0, config.mergeLimit);
    const priority = Math.max(...eligible.map((trigger) => trigger.priority));
    const waited = Math.max(0, input.worldTick - first.createdTick);
    const score = priority + Math.min(config.agingCap, waited * config.agingPerTick);
    candidates.push({ agentId, score, firstTick: first.createdTick, triggers: merged });
  }

  return candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.firstTick - right.firstTick ||
        left.agentId.localeCompare(right.agentId),
    )
    .slice(0, config.maxConcurrentTurns)
    .map((candidate) => ({
      agentId: candidate.agentId,
      triggerIds: candidate.triggers.map((trigger) => trigger.triggerId),
      score: candidate.score,
    }));
}

class FairSchedulingPort implements SchedulingPort {
  constructor(private readonly config: SchedulingConfig) {}

  plan(input: SchedulingInput): ReturnType<SchedulingPort["plan"]> {
    return planSchedule(input, this.config);
  }
}

export function createSchedulingModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = schedulingConfigSchema.parse(input.config);
  return createStatelessModule(input, new FairSchedulingPort(config));
}
