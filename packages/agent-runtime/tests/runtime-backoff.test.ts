/**
 * 核心职责：验证运行时轮询的失败退避与空闲巡检序列、单调性、上限钳制与非法输入处理。
 * 交互契约：只调用纯函数 cycleBackoffMs 与 idleDelayMs，不启动计时器、SQLite、网络或宿主资源。
 * 约束与禁忌：禁止把退避上限放宽到接近世界 tick，也不得让非法输入抛错或返回非正延迟。
 */
import { describe, expect, it } from "vitest";
import { cycleBackoffMs, idleDelayMs, nextCycleDelayMs, wakeDelayMs } from "../src/runtime-backoff";

describe("cycleBackoffMs", () => {
  it("按 2 的幂增长并在 5000 毫秒钳制", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(cycleBackoffMs)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });

  it("随连续失败次数单调不减，且始终落在 250 到 5000 之间", () => {
    let previous = 0;
    for (let failures = 1; failures <= 32; failures += 1) {
      const delay = cycleBackoffMs(failures);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeGreaterThanOrEqual(250);
      expect(delay).toBeLessThanOrEqual(5000);
      previous = delay;
    }
    expect(previous).toBe(5000);
  });

  it("远超上限的失败次数仍钳制在 5000 毫秒而不是溢出", () => {
    expect(cycleBackoffMs(200)).toBe(5000);
    expect(Number.isFinite(cycleBackoffMs(1000))).toBe(true);
    expect(cycleBackoffMs(1000)).toBe(5000);
  });

  it("0、负数、小数与 NaN 都按首次失败处理", () => {
    expect(cycleBackoffMs(0)).toBe(250);
    expect(cycleBackoffMs(-3)).toBe(250);
    expect(cycleBackoffMs(0.5)).toBe(250);
    expect(cycleBackoffMs(Number.NaN)).toBe(250);
  });

  it("非整数向下取整后套用同一序列", () => {
    expect(cycleBackoffMs(1.9)).toBe(250);
    expect(cycleBackoffMs(2.7)).toBe(500);
    expect(cycleBackoffMs(3.2)).toBe(1000);
  });
});

describe("idleDelayMs", () => {
  it("空闲巡检同样按 2 的幂增长并在 5000 毫秒钳制", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(idleDelayMs)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });

  it("首轮空闲即按基准间隔巡检，不会因为计数为 0 退化为 0 毫秒", () => {
    expect(idleDelayMs(0)).toBe(250);
    expect(idleDelayMs(-3)).toBe(250);
    expect(idleDelayMs(Number.NaN)).toBe(250);
    expect(idleDelayMs(0.5)).toBe(250);
  });

  it("随空闲轮数单调不减，且始终落在 250 到 5000 之间", () => {
    let previous = 0;
    for (let idle = 1; idle <= 32; idle += 1) {
      const delay = idleDelayMs(idle);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeGreaterThanOrEqual(250);
      expect(delay).toBeLessThanOrEqual(5000);
      previous = delay;
    }
    expect(previous).toBe(5000);
  });

  it("空闲上限低于 20 秒世界 tick，巡检不会让运行时错过推进", () => {
    expect(idleDelayMs(1000)).toBeLessThan(20_000);
  });
});
describe("nextCycleDelayMs", () => {
  it("失败期间保持故障退避，待处理信号不得把重试提前", () => {
    // 频繁的世界变化不能放大故障负载：有信号时仍按失败次数退避。
    expect(nextCycleDelayMs({ consecutiveFailures: 1, idleCycles: 0, wakePending: true })).toBe(250);
    expect(nextCycleDelayMs({ consecutiveFailures: 3, idleCycles: 0, wakePending: true })).toBe(1000);
    expect(nextCycleDelayMs({ consecutiveFailures: 6, idleCycles: 0, wakePending: true })).toBe(5000);
  });

  it("有信号且未失败时按最短延迟重跑，优先于空闲巡检", () => {
    // 空闲计数已累加时，信号仍要把下一轮提前到最短延迟。
    expect(nextCycleDelayMs({ consecutiveFailures: 0, idleCycles: 5, wakePending: true })).toBe(wakeDelayMs);
    expect(nextCycleDelayMs({ consecutiveFailures: 0, idleCycles: 0, wakePending: true })).toBe(wakeDelayMs);
  });

  it("既无信号也无失败时按空闲巡检退避", () => {
    expect(nextCycleDelayMs({ consecutiveFailures: 0, idleCycles: 0, wakePending: false })).toBe(250);
    expect(nextCycleDelayMs({ consecutiveFailures: 0, idleCycles: 2, wakePending: false })).toBe(1000);
    expect(nextCycleDelayMs({ consecutiveFailures: 0, idleCycles: 20, wakePending: false })).toBe(5000);
  });

  it("最短延迟仍为正数，信号不会退化成同步重跑", () => {
    // 同一段时间内的多条提交要被合并成一轮，因此延迟不能为 0。
    expect(wakeDelayMs).toBeGreaterThan(0);
    expect(wakeDelayMs).toBeLessThan(250);
  });
});
