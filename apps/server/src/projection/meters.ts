/**
 * 核心职责：从世界端口构建局势指标的玩家可见视图与展示等级。
 * 交互契约：依赖世界端口与玩家投影的指标 schema 视图；缺省端口时返回 null。
 * 约束与禁忌：等级阈值与规则第 4 节一致；禁止读取内部指标原始事件。
 */
import type { PlayerMetersView } from "@ai-npc/contracts";
import type { GameWorldPort } from "@ai-npc/module-sdk";

/** 局势指标的展示等级（规则第 4 节）：≤20 危急、21–39 紧张、≥40 稳定。 */
export function meterLevel(value: number): "critical" | "strained" | "stable" {
  if (value <= 20) {
    return "critical";
  }
  return value <= 39 ? "strained" : "stable";
}

export function metersView(world: GameWorldPort): PlayerMetersView | null {
  const value = world.meters();
  if (value === null) {
    return null;
  }
  return {
    relayStability: { value: value["relay.stability"], level: meterLevel(value["relay.stability"]) },
    orchardWater: { value: value["orchard.water"], level: meterLevel(value["orchard.water"]) },
    migrationSafety: { value: value["migration.safety"], level: meterLevel(value["migration.safety"]) },
    watergateAllocation: value["watergate.allocation"],
  };
}
