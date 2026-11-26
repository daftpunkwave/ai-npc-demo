/**
 * 验证升级版剧情的卡片提前倍率与取整边界。
 * 依赖剧情模块的纯计算函数；不加载内容包、不构造事务。
 * 禁止在此断言与实现无关的具体卡片 ID：本用例只锁定倍率与取整语义。
 */
import { describe, expect, it } from "vitest";
import { scaledTick } from "../src/contributor";

describe("升级版卡片触发 tick", () => {
  it("标准剧情不改动触发 tick", () => {
    for (const atTick of [1, 2, 26, 144]) {
      expect(scaledTick(atTick, false)).toBe(atTick);
    }
  });

  it("升级版按倍率前移并向下取整", () => {
    // 偶数倍率结果无歧义，先确认倍率本身。
    expect(scaledTick(2, true)).toBe(1);
    expect(scaledTick(26, true)).toBe(19);
    // 奇数结果必须向下取整而不是四舍五入：6×0.75=4.5 → 4。
    expect(scaledTick(6, true)).toBe(4);
    // 边界：tick 0 与 1 前移后都不小于 0。
    expect(scaledTick(0, true)).toBe(0);
    expect(scaledTick(1, true)).toBe(0);
  });

  it("前移后的 tick 始终严格早于原 tick（除 0 外）", () => {
    for (const atTick of [1, 2, 6, 26, 30, 44, 50, 72, 96, 144]) {
      const scaled = scaledTick(atTick, true);
      expect(scaled).toBeLessThan(atTick);
      expect(scaled).toBeGreaterThanOrEqual(0);
    }
  });
});
