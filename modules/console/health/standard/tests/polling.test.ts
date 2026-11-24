/**
 * 验证健康页轮询的可见性判定：后台标签页不读、前台与未知状态继续读。
 * 依赖纯判定函数与注入的可见性状态；不启动浏览器、不发起请求。
 * 禁止把不可见页面当作仍需轮询，也禁止因拿不到状态而永久停摆。
 */
import { describe, expect, it } from "vitest";
import { shouldPollHealth } from "../src/polling";

describe("健康页轮询的页面可见性判定", () => {
  it("可见时读取", () => {
    expect(shouldPollHealth("visible")).toBe(true);
  });

  it("后台或预渲染时跳过读取", () => {
    expect(shouldPollHealth("hidden")).toBe(false);
    expect(shouldPollHealth("prerender")).toBe(false);
  });

  it("状态缺失时保持读取，避免非浏览器环境下永久停摆", () => {
    expect(shouldPollHealth(undefined)).toBe(true);
  });
});
