/**
 * 把已校验内容包收窄为游戏端口视图；只做索引映射，不复制数据。
 * 依赖公共契约的内容包类型与 module-sdk 视图类型；视图实体类型由内容类型派生，
 * 返回类型要求逐项给出 GameContent 的每个必需字段，漏映射时无法通过类型检查。不依赖游戏模块。
 * 禁止在此读取环境变量、打开存储或补默认业务值。
 */
import type { ContentPack } from "@world-prism/contracts";
import type { GameContent } from "@world-prism/module-sdk";

export function toGameContent(content: ContentPack): GameContent {
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
    scenarios: content.index.scenarios,
    defaultScenario: content.pack.defaultScenario,
    rules: content.rules,
    notificationTexts: content.locale.notifications,
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
