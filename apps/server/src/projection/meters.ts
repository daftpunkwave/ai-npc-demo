/**
 * 核心职责：从世界端口构建局势指标的玩家可见视图与展示等级。
 * 交互契约：依赖世界端口、玩家投影的指标 schema 视图与 module-sdk 的统一等级判定；缺省端口时返回 null。
 * 约束与禁忌：等级阈值以 module-sdk 的统一判定为准，本文件不再复制阈值；禁止读取内部指标原始事件。
 */
import type { PlayerMetersView } from "@world-prism/contracts";
import { meterLevel, type GameWorldPort } from "@world-prism/module-sdk";

export { meterLevel };

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
