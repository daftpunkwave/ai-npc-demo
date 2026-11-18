/**
 * 构建玩家可见投影：只从世界/地图端口与内容索引读取公开字段。
 * 依赖玩家投影 schema、内容与模块端口；不读取 Agent 私有记忆。
 * 禁止把内部任务风险、秘密正文或模型输出直接放入投影。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将投影联合类型误判为 any。 */
import {
  playerProjectionSchema,
  type ClockView,
  type PlayerProjection,
  type PlayerMetersView,
  type PlayerTaskView,
} from "@ai-npc/contracts";
import type { GameContent, GameMapPort, GameWorldPort } from "@ai-npc/module-sdk";

function level(value: number): "critical" | "strained" | "stable" {
  if (value <= 20) {
    return "critical";
  }
  return value <= 39 ? "strained" : "stable";
}

function meters(world: GameWorldPort): PlayerMetersView | null {
  const value = world.meters();
  if (value === null) {
    return null;
  }
  return {
    relayStability: { value: value["relay.stability"], level: level(value["relay.stability"]) },
    orchardWater: { value: value["orchard.water"], level: level(value["orchard.water"]) },
    migrationSafety: { value: value["migration.safety"], level: level(value["migration.safety"]) },
    watergateAllocation: value["watergate.allocation"],
  };
}

/** 构建完整玩家投影；未实现的集合先保持为空，避免伪造私有数据。 */
export function buildPlayerProjection(input: {
  readonly content: GameContent;
  readonly world: GameWorldPort;
  readonly map: GameMapPort;
  readonly clock: ClockView;
}): PlayerProjection {
  const { content, world, map, clock } = input;
  const campaign = world.campaign();
  const nodeViews = [...content.nodes.values()].map((node) => ({
    nodeId: node.nodeId,
    name: node.name,
    x: node.x,
    y: node.y,
    facilities: [...node.facilities],
  }));
  const roadViews = [...content.roads.values()].map((road) => ({
    roadId: road.roadId,
    fromNodeId: road.a,
    toNodeId: road.b,
    travelTicks: road.travelTicks,
    risk: road.risk,
    status: map.roadStatus(road.roadId) ?? "open",
  }));
  const tasks: PlayerTaskView[] = [];
  const meterView = meters(world);
  if (meterView === null) {
    throw new Error("世界指标尚未初始化，不能构建玩家投影");
  }
  return playerProjectionSchema.parse({
    campaign: campaign === null
      ? null
      : {
          campaignId: campaign.campaignId,
          factionId: campaign.factionId,
          factionName: content.factions.get(campaign.factionId)?.name ?? campaign.factionId,
          commission: content.starts.get(campaign.factionId)?.commission ?? "第 7 日",
          status: campaign.status,
          outcome: campaign.outcome,
          startTick: campaign.startTick,
        },
    clock,
    map: { nodes: nodeViews, roads: roadViews },
    meters: meterView,
    stockpiles: [],
    teams: [],
    characters: [],
    tasks,
    agreements: [],
    invitations: [],
    conversations: [],
    inbox: [],
    notebook: [],
    awaitingReplyFrom: [],
    notifications: [],
  });
}
