/**
 * 核心职责：组装玩家可见投影，聚合地图、指标、库存、队伍、角色、任务、协议、通信与提醒视图。
 * 交互契约：依赖玩家投影 schema、内容索引与各游戏端口；投影规则位于 projection/ 域文件。
 * 约束与禁忌：不读取 Agent 私有记忆、领域事件流或模型输出；缺少可选端口时对应集合为空，绝不伪造私有数据。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将投影联合类型误判为 any。 */
import {
  playerProjectionSchema,
  type ClockView,
  type PlayerProjection,
} from "@ai-npc/contracts";
import type {
  GameActionsPort,
  GameAgreementsPort,
  GameCommsPort,
  GameContent,
  GameMapPort,
  GameResourcesPort,
  GameWorldPort,
} from "@ai-npc/module-sdk";
import { campaignViewOf } from "./projection/campaign";
import { metersView } from "./projection/meters";
import { stockpileViews } from "./projection/resources";
import { characterViews, teamViews } from "./projection/world-views";
import { taskViews } from "./projection/tasks";
import { agreementViews } from "./projection/agreements";
import {
  awaitingReplyFrom,
  conversationLines,
  inboxItems,
  notebookEntries,
} from "./projection/comms";
import { notificationViews } from "./projection/notifications";

export { campaignViewOf } from "./projection/campaign";

/** 投影输入：world/map 必填，其余游戏端口可选。 */
export interface PlayerProjectionInput {
  readonly content: GameContent;
  readonly clock: ClockView;
  readonly world: GameWorldPort;
  readonly map: GameMapPort;
  /** 通信端口：缺省时不输出会话、收件箱、知识笔记与待回复角色。 */
  readonly comms?: GameCommsPort;
  /** 资源端口：缺省时不输出库存点。 */
  readonly resources?: GameResourcesPort;
  /** 行动端口：缺省时不输出任务。 */
  readonly actions?: GameActionsPort;
  /** 协议端口：缺省时不输出协议与到期提醒。 */
  readonly agreements?: GameAgreementsPort;
  /** 玩家主体 ID；缺省用内容包声明的玩家主体。 */
  readonly playerPrincipalId?: string;
  /** 玩家显示名；缺省用主体 ID。 */
  readonly playerName?: string;
  /** 正在排队或执行 turn 的角色；由宿主调度器提供，缺省视为没有待回复。 */
  readonly awaitingReplyCharacters?: readonly string[];
}

/** 构建完整玩家投影；缺少可选端口时对应集合为空，绝不伪造私有数据。 */
export function buildPlayerProjection(input: PlayerProjectionInput): PlayerProjection {
  const { content, clock, world, map } = input;
  const tick = clock.worldTick;
  const playerPrincipalId = input.playerPrincipalId ?? content.playerPrincipalId;
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
  const meterView = metersView(world);
  const delegations = world.delegationsOf(playerPrincipalId);
  const stockpiles = stockpileViews({
    content,
    resources: input.resources,
    delegations,
    tick,
  });
  const teams = teamViews({ world, delegations, tick });
  const characters = characterViews({ content, world, tick });
  const tasks = taskViews({ actions: input.actions, world, playerPrincipalId });
  const agreements = agreementViews(input.agreements, playerPrincipalId);
  const conversations = conversationLines({
    content,
    comms: input.comms,
    playerPrincipalId,
    playerName: input.playerName,
    tick,
  });
  const inbox = inboxItems(input.comms, playerPrincipalId);
  const notebook = notebookEntries(content, input.comms, playerPrincipalId);
  return playerProjectionSchema.parse({
    campaign: campaign === null ? null : campaignViewOf(campaign, content),
    clock,
    map: { nodes: nodeViews, roads: roadViews },
    meters: meterView,
    cityResources: campaign?.cityResources ?? null,
    stockpiles,
    teams,
    characters,
    tasks,
    agreements,
    // 首版规则只邀请 Agent 角色，玩家不会被邀请；字段保留给后续多席位邀请，当前恒为空。
    invitations: [],
    conversations,
    inbox,
    notebook,
    awaitingReplyFrom: awaitingReplyFrom({
      content,
      comms: input.comms,
      playerPrincipalId,
      awaitingReplyCharacters: input.awaitingReplyCharacters ?? [],
    }),
    notifications: notificationViews({
      agreements,
      owns: tasks.filter((task) => task.kind === "own"),
      meters: meterView,
      inbox,
      texts: content.notificationTexts,
      playerPrincipalId,
      tick,
    }),
  });
}
