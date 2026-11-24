/**
 * 把已校验内容包收窄为游戏端口视图；只做索引映射，不复制数据。
 * 依赖 experiment 内容类型与 module-sdk 视图类型；不依赖游戏模块。
 * 禁止在此读取环境变量、打开存储或补默认业务值。
 */
import type { ContentPack } from "@ai-npc/experiment";
import type { GameContent, GameNotificationTexts, GameScenario, GameScenarioCard } from "@ai-npc/module-sdk";

/** 已校验剧情内容中适配器透传所需的最小形状。 */
interface ContentScenarioView {
  readonly broadcastOriginNodeId: string;
  readonly pressureCardId?: string;
  readonly signatureOnlyPrincipalIds: readonly string[];
  readonly cards: readonly GameScenarioCard[];
}

/** 把一份剧情内容收窄为剧情端口视图；元数据随卡片一起透传。 */
function toGameScenario(scenarioId: string, scenario: ContentScenarioView): GameScenario {
  return {
    scenarioId,
    broadcastOriginNodeId: scenario.broadcastOriginNodeId,
    ...(scenario.pressureCardId === undefined ? {} : { pressureCardId: scenario.pressureCardId }),
    signatureOnlyPrincipalIds: scenario.signatureOnlyPrincipalIds,
    cards: scenario.cards,
  };
}

export function toGameContent(content: ContentPack): GameContent {
  const scenarios = new Map<string, GameScenario>();
  for (const [scenarioId, scenario] of content.index.scenarios) {
    scenarios.set(scenarioId, toGameScenario(scenarioId, scenario));
  }
  const notifications = content.locale.notifications;
  const texts: GameNotificationTexts = {
    invite: notifications.invite,
    deadline: notifications.deadline,
    failedTask: notifications.failedTask,
    crisis: notifications.crisis,
  };
  return {
    nodes: content.index.nodes,
    roads: content.index.roads,
    factions: content.index.factions,
    characters: content.index.characters,
    stockpiles: content.index.stockpiles,
    teams: content.index.teams,
    groups: content.index.groups,
    evidence: content.index.evidence,
    secrets: content.index.secrets,
    starts: content.index.starts,
    scenarios,
    defaultScenario: content.pack.defaultScenario,
    rules: content.rules,
    notificationTexts: texts,
    migrationRoads: content.map.migrationRoads,
    medicalFacilities: content.map.medicalFacilities,
    playerNodeId: content.worldInit.player.nodeId,
    playerPrincipalId: content.index.playerPrincipalId,
    chapterId: content.lore.chapter.id,
    initialMeters: content.worldInit.meters,
    dutyDelegations: content.worldInit.dutyDelegations,
    ...(content.worldInit.cityResources === undefined ? {} : { cityResources: content.worldInit.cityResources }),
  };
}
