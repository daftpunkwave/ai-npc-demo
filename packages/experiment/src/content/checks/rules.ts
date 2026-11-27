/**
 * 校验章节规则参数引用的内容对象：岗位主体、豁免队伍、工作节点、日结库存、迁徙道路与公社席。
 * 依赖内容 schema 类型与共用失败辅助；只读取已解析的数据，不访问文件系统。
 * 禁止修补缺失引用、默认化数值或在校验中执行规则。
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions -- 内容 ID 已由 schema 约束为字符串；缺少完整类型信息时规则会把推断类型视为 unknown。 */
import type {
  ContentCharacters,
  ContentFactions,
  ContentNode,
  ContentRoad,
  ContentRules,
  ContentStockpile,
  ContentTeam,
} from "@world-prism/contracts";
import { fail } from "./common";

/** 规则参数文件在错误信息中的固定来源名。 */
const rulesSource = "rules.yaml";

/** 校验规则参数的全部内容引用与公社席声明。 */
export function checkRules(
  rules: ContentRules,
  factionsFile: ContentFactions,
  charactersFile: ContentCharacters,
  nodes: ReadonlyMap<string, ContentNode>,
  roads: ReadonlyMap<string, ContentRoad>,
  stockpiles: ReadonlyMap<string, ContentStockpile>,
  teams: ReadonlyMap<string, ContentTeam>,
): void {
  const tasks = rules.tasks;
  // 岗位主体必须是已定义的角色：运行时的随队加成按角色档案的派系归属判定，
  // 只有派系身份（AI 党魁）没有角色档案，配为岗位会通过校验却永远不触发加成。
  const characterIds = new Set(charactersFile.characters.map((character) => character.agentId));
  const requireCharacter = (agentId: string, path: string): void => {
    if (!characterIds.has(agentId)) {
      fail(rulesSource, path, `岗位主体「${agentId}」不是内容包定义的角色`);
    }
  };
  const requireTeam = (teamId: string, path: string): void => {
    if (!teams.has(teamId)) {
      fail(rulesSource, path, `引用的队伍「${teamId}」不存在`);
    }
  };
  requireCharacter(tasks.capacitySupporter.agentId, "tasks.capacitySupporter.agentId");
  requireCharacter(tasks.repairSupporter.agentId, "tasks.repairSupporter.agentId");
  requireCharacter(tasks.rescueSupporter.agentId, "tasks.rescueSupporter.agentId");
  requireCharacter(tasks.scoutSupporter.agentId, "tasks.scoutSupporter.agentId");
  requireCharacter(tasks.escortSupporter.agentId, "tasks.escortSupporter.agentId");
  requireCharacter(tasks.universalGuide.agentId, "tasks.universalGuide.agentId");
  requireCharacter(tasks.universalRepairer.agentId, "tasks.universalRepairer.agentId");
  tasks.universalRepairer.excludedTeamIds.forEach((teamId, index) => {
    requireTeam(teamId, `tasks.universalRepairer.excludedTeamIds.${index}`);
  });
  tasks.energyOnlyRepairTeamIds.forEach((teamId, index) => {
    requireTeam(teamId, `tasks.energyOnlyRepairTeamIds.${index}`);
  });
  if (!nodes.has(tasks.repairWorkNodeId)) {
    fail(rulesSource, "tasks.repairWorkNodeId", `修复工作节点「${tasks.repairWorkNodeId}」不存在`);
  }

  const settlement = rules.settlement;
  const requireStockpile = (stockpileId: string, path: string): void => {
    if (!stockpiles.has(stockpileId)) {
      fail(rulesSource, path, `日结目标库存点「${stockpileId}」不存在`);
    }
  };
  requireStockpile(settlement.dailySupplyStockpileId, "settlement.dailySupplyStockpileId");
  requireStockpile(settlement.orchardMedicalStockpileId, "settlement.orchardMedicalStockpileId");
  // 道路端点与存在性由地图校验负责，这里只要求规则引用的道路在地图中已登记。
  if (!roads.has(settlement.migrationRoadId)) {
    fail(rulesSource, "settlement.migrationRoadId", `迁徙道路「${settlement.migrationRoadId}」不存在`);
  }
  if (!factionsFile.factions.some((faction) => faction.factionId === settlement.migrationPassageFactionId)) {
    fail(
      rulesSource,
      "settlement.migrationPassageFactionId",
      `迁徙通行派系「${settlement.migrationPassageFactionId}」不存在`,
    );
  }

  // 公社席必须至少被一个派系持有，否则水闸权限与广播权没有承担者。
  if (!factionsFile.factions.some((faction) => faction.playerSeat === rules.watergateSeatId)) {
    fail(rulesSource, "watergateSeatId", `席位「${rules.watergateSeatId}」没有被任何派系声明为 playerSeat`);
  }
}
