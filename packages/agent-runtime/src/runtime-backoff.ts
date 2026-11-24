/**
 * 核心职责：给出 Agent 运行时轮询失败后的退避延迟，把固定间隔重试换成有上限的指数退避。
 * 交互契约：纯函数，只接收连续失败轮数并返回下一次轮询延迟毫秒数；不读时钟、环境、随机源或存储。
 * 约束与禁忌：禁止让上限接近世界 tick 周期，也禁止对负数、非整数或非有限输入抛错。
 */

/** 首次失败后的基准延迟，与历史固定轮询间隔一致。 */
const baseDelayMs = 250;

/**
 * 上限 5 秒远低于 20 秒世界 tick：持续失败时摄入与调度仍每轮推进，
 * 退避只降低失败重试频率，不能让运行时停摆。
 */
const maxDelayMs = 5_000;

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
