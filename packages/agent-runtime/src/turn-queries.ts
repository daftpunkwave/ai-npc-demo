/**
 * 从本轮冻结的授权观察构造工具查询结果。
 * 读取可见地图事实、会话片段和本轮真实回执，寻路复用地图模块的纯算法。
 * 禁止查询实时世界真值、窥视其他主体的会话或用查询刷新输入水位。
 */
import {
  dayPassedPayloadSchema, dialogueSubmittedPayloadSchema, DomainError, metersChangedPayloadSchema,
  passageGrantedPayloadSchema, policyChangedPayloadSchema, roadStatusSchema, type Json,
} from "@ai-npc/contracts";
import type { ContentPack } from "@ai-npc/experiment";
import { findRoadPath } from "@ai-npc/module-sdk";
import { asRecord } from "./runtime-records";
import type { QueryExecutionInput, ToolCallOutcome } from "./tool-gateway-types";
import type { FrozenTurnInput } from "./turn-input";

export function turnQueries(input: {
  readonly frozen: FrozenTurnInput;
  readonly content: ContentPack;
  readonly toolCalls: readonly ToolCallOutcome[];
  readonly historyTurns: number;
}) {
  const { frozen, content } = input;
  const { worldTick } = frozen.frontier;
  const factionId = frozen.world.principalFactions.get(frozen.scope.agentId);
  const observed = frozen.observations.map((item) => {
    const data = asRecord(item.content);
    return { tick: item.occurredAtTick, type: data["eventType"], facts: data["facts"], observationId: item.observationId };
  }).sort((left, right) => left.tick - right.tick);

  const roads = new Map<string, { status: "open" | "restricted" | "closed"; asOfTick: number; observationId: string }>();
  const meters: Record<string, Json> = {};
  const grants = new Set<string>();
  let allocation: Json = null;
  for (const { tick, type, facts, observationId } of observed) {
    if (type === "PolicyChanged") {
      const policy = policyChangedPayloadSchema.safeParse(facts);
      if (!policy.success) continue;
      if (policy.data.key === "watergate.allocation") allocation = { value: policy.data.newValue, asOfTick: tick, observationId };
      const prefix = "road.status:";
      if (!policy.data.key.startsWith(prefix)) continue;
      const status = roadStatusSchema.safeParse(policy.data.newValue);
      if (status.success) roads.set(policy.data.key.slice(prefix.length), { status: status.data, asOfTick: tick, observationId });
    } else if (type === "PassageGranted") {
      const grant = passageGrantedPayloadSchema.safeParse(facts);
      if (grant.success && grant.data.granteeFactionId === factionId && grant.data.untilTick >= worldTick) grants.add(grant.data.roadId);
    } else if (type === "MetersChanged") {
      const parsed = metersChangedPayloadSchema.safeParse(facts);
      if (parsed.success) for (const change of parsed.data.changes) {
        meters[change.meter] = { value: change.to, asOfTick: tick, observationId };
      }
    } else if (type === "DayPassed") {
      const parsed = dayPassedPayloadSchema.safeParse(facts);
      if (parsed.success) for (const [key, value] of Object.entries(parsed.data.meters)) {
        meters[key] = { value, asOfTick: tick, observationId };
      }
    }
  }

  return ({ toolId, arguments: args }: QueryExecutionInput): Json => {
    const params = asRecord(args);
    switch (toolId) {
      case "world.inspect": {
        const nodeId = params["nodeId"];
        if (typeof nodeId === "string" && !content.index.nodes.has(nodeId)) {
          throw new DomainError("not-found", "该地点不在已知地图中");
        }
        return {
          asOfTick: worldTick, meters, allocation,
          roads: [...content.index.roads.values()].filter((road) => nodeId === undefined || road.a === nodeId || road.b === nodeId)
            .map((road) => ({ roadId: road.roadId, a: road.a, b: road.b, risk: road.risk, known: roads.get(road.roadId) ?? null })),
          characters: frozen.world.nodeId !== null && (nodeId === undefined || frozen.world.nodeId === nodeId)
            ? [{ agentId: frozen.scope.agentId, nodeId: frozen.world.nodeId, injured: frozen.world.injured }] : [],
          stockpileLevels: [],
        };
      }
      case "route.inspect": {
        const teamId = params["teamId"];
        if (typeof teamId === "string") {
          const team = content.index.teams.get(teamId);
          const delegated = frozen.world.delegations.some(({ teamIds }) => teamIds.includes(teamId));
          if (team === undefined || !delegated && team.ownerFactionId !== factionId) {
            throw new DomainError("forbidden", "无法为此队伍查看路线");
          }
        }
        const path = findRoadPath(content.index.nodes, content.index.roads.values(), {
          fromNodeId: String(params["fromNodeId"]), toNodeId: String(params["toNodeId"]),
          withCargo: typeof teamId === "string",
        }, (road) => {
          const known = roads.get(road.roadId);
          return known?.status === "open" || (known?.status === "restricted" &&
            (road.controlledBy === factionId || grants.has(road.roadId)));
        });
        return {
          path: [...(path?.roadIds ?? [])], travelTicks: path?.travelTicks ?? null,
          risks: (path?.roadIds ?? []).map((roadId) => ({ roadId, risk: content.index.roads.get(roadId)?.risk ?? null })),
          blockedRoads: [...roads].filter(([, { status }]) => status === "closed").map(([roadId]) => roadId),
        };
      }
      case "task.inspect": {
        const taskId = params["taskId"];
        const known = typeof taskId === "string" ? observed.findLast(({ facts, type }) =>
          typeof type === "string" && type.startsWith("Task") && asRecord(facts)["taskId"] === taskId) : undefined;
        if (known === undefined) throw new DomainError("not-found", "本轮材料中没有该任务");
        const facts = asRecord(known.facts);
        return { taskId: String(taskId), observationId: known.observationId, taskType: facts["taskType"] as Json ?? null,
          taskStatus: facts["taskStatus"] as Json ?? facts["status"] as Json ?? null,
          commandStatus: null, departTick: facts["departTick"] as Json ?? null,
          nominalCompletionTick: facts["nominalCompletionTick"] as Json ?? null };
      }
      case "conversation.inspect": {
        const dialogue = observed.flatMap(({ facts, type }) => {
          if (type !== "DialogueSubmitted") return [];
          const parsed = dialogueSubmittedPayloadSchema.safeParse(facts);
          return parsed.success ? [parsed.data] : [];
        });
        const conversationId = params["conversationId"] ??
          dialogue.find(({ dialogueId }) => dialogueId === frozen.frontier.conversationCursor)?.conversationId;
        const limit = Math.min(input.historyTurns, Number(params["limit"]));
        return { lines: limit > 0 ? dialogue.filter((line) => line.conversationId === conversationId)
          .slice(-limit).map(({ dialogueId, speakerId, text }) => ({ dialogueId, speakerId, text })) : [] };
      }
      case "operation.inspect": {
        const result = input.toolCalls.find(({ result }) => result.operationId === params["operationId"])?.result;
        return {
          receipt: result?.receiptId === undefined || result.receiptId === null ? null : {
            receiptId: result.receiptId, commandStatus: result.commandStatus, reasonCode: result.reasonCode,
          },
          taskStatus: result?.taskStatus ?? null,
        };
      }
      default:
        throw new DomainError("not-found", "该工具没有冻结查询入口");
    }
  };
}
