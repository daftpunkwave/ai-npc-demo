/**
 * 时钟视图转换：把 provider 的完整时钟状态收窄为对外的只读视图（tick、日、小时、模式与版本）。
 * 依赖公共契约的时钟状态与视图类型；不读取存储、不推进时钟。
 * 禁止在这里补默认值或把内部时钟字段直接暴露给客户端。
 */
import type { ClockView } from "@ai-npc/contracts";
import type { ClockState } from "@ai-npc/module-sdk";

/** 把内部时钟状态转换为对外视图；day/hour 由 worldTick 派生。 */
export function clockView(clock: ClockState): ClockView {
  return {
    worldTick: clock.worldTick,
    day: Math.floor(clock.worldTick / 24) + 1,
    hour: clock.worldTick % 24,
    mode: clock.mode,
    runVersion: clock.runVersion,
  };
}
