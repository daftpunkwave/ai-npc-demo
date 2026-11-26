/**
 * 核心职责：给出 Agent 运行时轮询的下一轮延迟，把固定高频轮询换成有上限的指数退避。
 * 交互契约：纯函数，只接收连续失败轮数或连续空闲轮数并返回下一次轮询延迟毫秒数；
 * 不读时钟、环境、随机源或存储。
 * 约束与禁忌：禁止让巡检上限接近世界 tick 周期，也禁止对负数、非整数或非有限输入抛错。
 */

/** 基准轮询间隔，与历史固定轮询一致：世界或信号一到就按该粒度响应。 */
const baseDelayMs = 250;

/**
 * 失败退避上限 5 秒远低于 20 秒世界 tick：持续失败时摄入与调度仍每轮推进，
 * 退避只降低失败重试频率，不能让运行时停摆。
 */
const maxDelayMs = 5_000;

/**
 * 空闲巡检上限 5 秒同样远低于世界 tick：世界推进或唤醒信号都会重置空闲计数，
 * 因此上限只决定「完全没变化时多久巡检一次」，不拖慢需求响应。
 */
const maxIdleDelayMs = 5_000;

/**
 * 按连续失败次数返回下一次轮询延迟：250、500、1000、2000、4000，之后钳制在 5000 毫秒。
 * 非整数向下取整；`0`、负数与 `NaN` 都按首次失败（1 次）处理。
 * @param consecutiveFailures 连续失败轮数，必须为有限数值语义；非法值按首次失败处理。
 * @returns 下一次轮询的延迟毫秒数，范围 `[250, 5000]`。
 */
export function cycleBackoffMs(consecutiveFailures: number): number {
  const failures = Math.max(
    1,
    Number.isNaN(consecutiveFailures) ? 1 : Math.floor(consecutiveFailures),
  );
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - 1));
}

/**
 * 按连续空闲轮数返回下一次巡检延迟：250、500、1000、2000、4000，之后钳制在 5000 毫秒。
 * 世界 tick 未变化且没有调度产出时用它退避；任何 tick 变化或唤醒信号都从 1 重新开始。
 * @param idleCycles 连续空闲轮数；`0`、负数与 `NaN` 按首轮空闲（1 次）处理。
 * @returns 下一次巡检的延迟毫秒数，范围 `[250, 5000]`。
 */
export function idleDelayMs(idleCycles: number): number {
  const idle = Math.max(
    1,
    Number.isNaN(idleCycles) ? 1 : Math.floor(idleCycles),
  );
  return Math.min(maxIdleDelayMs, baseDelayMs * 2 ** (idle - 1));
}
/** 收到世界变化信号后到下一轮的最短延迟：合并同一段时间内的多条提交。 */
export const wakeDelayMs = 25;

/** 轮询延迟的输入：失败退避、空闲巡检与「有信号等待处理」三者的优先级由此决定。 */
export interface CycleDelayState {
  /** 连续失败轮数；大于 0 时故障退避优先，唤醒信号不得缩短重试间隔。 */
  readonly consecutiveFailures: number;
  /** 连续空闲轮数：世界 tick 未变化且没有调度产出。 */
  readonly idleCycles: number;
  /** 是否已有尚未处理的世界变化信号。 */
  readonly wakePending: boolean;
}

/**
 * 下一轮延迟：失败退避 > 待处理信号 > 空闲巡检。
 * 失败期间保持退避，避免频繁的世界变化把故障重试放大成负载；
 * 有信号时按最短延迟重跑，让世界变化后尽早被处理；
 * 其余情况按空闲计数指数退避，避免世界没有变化时空转。
 * @param state 失败轮数、空闲轮数与待处理信号标记。
 * @returns 下一次轮询的延迟毫秒数，范围 `[25, 5000]`。
 */
export function nextCycleDelayMs(state: CycleDelayState): number {
  if (state.consecutiveFailures > 0) return cycleBackoffMs(state.consecutiveFailures);
  if (state.wakePending) return wakeDelayMs;
  return idleDelayMs(state.idleCycles + 1);
}
