/**
 * 覆盖调度优先级、老化、冷却、暂停、human 控制和单身份互斥。
 * 依赖纯调度函数与固定 trigger；不启动 worker。
 * 禁止为暂停态普通 trigger 或无活动身份的 trigger 创建计划。
 */
import { describe, expect, it } from "vitest";
import type { AgentTrigger } from "@ai-npc/contracts";
import type { SchedulingInput } from "@ai-npc/module-sdk";
import { planSchedule } from "../src/plugin";
import type { SchedulingConfig } from "../src/definition";

const config: SchedulingConfig = {
  maxConcurrentTurns: 2,
  mergeLimit: 3,
  cooldownTicks: 2,
  agingPerTick: 5,
  agingCap: 20,
  patrolHour: 8,
};

function trigger(id: number, agentId: string, kind: AgentTrigger["kind"], priority: number, createdTick = 10): AgentTrigger {
  return {
    triggerId: `trg-${String(id).padStart(12, "0")}`,
    agentId,
    kind,
    priority,
    sourceRef: `evt-${id}`,
    createdTick,
    dedupeKey: `${kind}:${agentId}:${id}`,
    consumedByTurnId: null,
  };
}

function input(overrides: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    branchId: "br-000000000001",
    worldTick: 10,
    paused: false,
    agents: [
      { agentId: "agent-a", active: true, controllerKind: "agent", strategic: false },
      { agentId: "agent-b", active: true, controllerKind: "agent", strategic: true },
    ],
    triggers: [],
    runningTurnAgentIds: [],
    lastTurnTickByAgent: {},
    ...overrides,
  };
}

describe("agent.scheduling.fair", () => {
  it("按优先级、等待老化、创建 tick 和 agentId 确定顺序", () => {
    const plan = planSchedule(
      input({
        triggers: [
          trigger(1, "agent-a", "message", 60, 8),
          trigger(2, "agent-b", "alert", 90, 9),
        ],
      }),
      config,
    );
    expect(plan.map((item) => item.agentId)).toEqual(["agent-b", "agent-a"]);
  });

  it("同一身份只创建一次并合并到 mergeLimit", () => {
    const plan = planSchedule(
      input({
        triggers: [
          trigger(1, "agent-a", "message", 60),
          trigger(2, "agent-a", "message", 50),
          trigger(3, "agent-a", "message", 40),
          trigger(4, "agent-a", "message", 30),
        ],
      }),
      config,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]?.triggerIds).toHaveLength(3);
  });

  it("冷却期内只允许玩家对白、debug 与 probe", () => {
    const plan = planSchedule(
      input({
        triggers: [
          trigger(1, "agent-a", "message", 60),
          trigger(2, "agent-b", "player-dialogue", 100),
        ],
        lastTurnTickByAgent: { "agent-a": 9, "agent-b": 9 },
      }),
      config,
    );
    expect(plan.map((item) => item.agentId)).toEqual(["agent-b"]);
  });

  it("暂停时只调度 debug 与 probe，human 控制身份永不调度", () => {
    const plan = planSchedule(
      input({
        paused: true,
        agents: [
          { agentId: "agent-a", active: true, controllerKind: "agent", strategic: false },
          { agentId: "agent-b", active: true, controllerKind: "human", strategic: true },
        ],
        triggers: [
          trigger(1, "agent-a", "message", 60),
          trigger(2, "agent-a", "probe", 100),
          trigger(3, "agent-b", "debug", 100),
        ],
      }),
      config,
    );
    expect(plan.map((item) => item.agentId)).toEqual(["agent-a"]);
  });
});
