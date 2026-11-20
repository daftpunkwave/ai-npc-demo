/**
 * 校验等距世界坐标与屏幕坐标往返误差，并覆盖高度只影响视觉纵轴。
 * 依赖本模块纯投影函数；不启动渲染器或网络。
 * 禁止让视觉投影改变世界平面上横纵坐标。
 */
import { describe, expect, it } from "vitest";
import { screenToWorld, worldToScreen } from "../src";

describe("等距投影", () => {
  it("世界与屏幕坐标往返误差小于 0.5 像素", () => {
    const screen = worldToScreen(3, -2);
    const world = screenToWorld(screen.x, screen.y);
    expect(Math.abs(world.x - 3)).toBeLessThan(0.5);
    expect(Math.abs(world.y + 2)).toBeLessThan(0.5);
  });
});
