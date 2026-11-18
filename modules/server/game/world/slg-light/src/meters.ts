/**
 * 计算指标截断、展示等级与首次阈值事件，供每日结算和任务效果共用。
 * 依赖公共契约的指标值与快照类型；只返回应提交的事件，不直接写世界状态。
 * 禁止重复触发已被记录的事件，或把水闸分配当作数值指标处理。
 */
import type { MeterSnapshot } from "@ai-npc/contracts";
import type { MetersView } from "@ai-npc/module-sdk";

/** 指标阈值事件；value 为触发后的当前值。 */
export interface MeterThresholdEvent {
  readonly type:
    | "RelayDegraded"
    | "RelayDown"
    | "RelayRestored"
    | "OrchardCrisis"
    | "OrchardDamaged"
    | "MigrationCrisis";
  readonly value: number;
}

/** 把任意数值截断到 0–100。 */
export function clampMeter(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** 指标展示等级。 */
export function meterLevel(value: number): "critical" | "strained" | "stable" {
  if (value <= 20) {
    return "critical";
  }
  if (value <= 39) {
    return "strained";
  }
  return "stable";
}

/** 从指标状态构造公开快照。 */
export function metersSnapshot(meters: MetersView): MeterSnapshot {
  return {
    "relay.stability": meters["relay.stability"],
    "orchard.water": meters["orchard.water"],
    "migration.safety": meters["migration.safety"],
    "watergate.allocation": meters["watergate.allocation"],
  };
}

/** 计算一次变化后应触发的阈值事件，并返回新触发集合。 */
export function thresholdEvents(
  previous: MetersView,
  next: MetersView,
  triggered: ReadonlySet<string>,
): { readonly events: readonly MeterThresholdEvent[]; readonly added: readonly string[] } {
  const events: MeterThresholdEvent[] = [];
  const added: string[] = [];
  const add = (type: MeterThresholdEvent["type"], value: number): void => {
    if (triggered.has(type) || added.includes(type)) {
      return;
    }
    events.push({ type, value });
    added.push(type);
  };
  if (previous["relay.stability"] >= 30 && next["relay.stability"] < 30) {
    add("RelayDegraded", next["relay.stability"]);
  }
  if (next["relay.stability"] === 0) {
    add("RelayDown", 0);
  }
  if (previous["relay.stability"] < 30 && next["relay.stability"] >= 30) {
    events.push({ type: "RelayRestored", value: next["relay.stability"] });
  }
  if (previous["orchard.water"] > 20 && next["orchard.water"] <= 20) {
    add("OrchardCrisis", next["orchard.water"]);
  }
  if (next["orchard.water"] === 0) {
    add("OrchardDamaged", 0);
  }
  if (previous["migration.safety"] > 20 && next["migration.safety"] <= 20) {
    add("MigrationCrisis", next["migration.safety"]);
  }
  return { events, added };
}
