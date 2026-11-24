/**
 * 核心职责：验证运行时轮询退避序列、单调性与上限钳制，以及非法输入按首次失败处理。
 * 交互契约：只调用纯函数 cycleBackoffMs，不启动计时器、SQLite、网络或宿主资源。
 * 约束与禁忌：禁止把退避上限放宽到接近世界 tick，也不得让非法输入抛错或返回非正延迟。
 */
import { describe, expect, it } from "vitest";
import { cycleBackoffMs } from "../src/runtime-backoff";

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
