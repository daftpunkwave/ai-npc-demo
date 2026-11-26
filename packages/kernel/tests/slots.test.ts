/**
 * 验证 slot 贡献的稳定排序、分组与冲突检测。
 * 依赖 kernel 的 orderSlotContributions 与测试夹具的错误断言，不涉及真实 UI 模块。
 * 禁止断言注册顺序无法解释的排序结果或绕过冲突检查。
 */
import { describe, expect, it } from "vitest";
import type { ContributionRef } from "@world-prism/contracts";
import { orderSlotContributions } from "../src/index";
import { detailsText, expectDomainError } from "./support";

function contribution(extensionId: string, slot: string, order: number): ContributionRef {
  return { extensionId, slot, order };
}

describe("slot 贡献排序", () => {
  it("按 order 升序排列，相同 order 保持注册顺序", () => {
    const ordered = orderSlotContributions([
      contribution("hud.second", "hud", 20),
      contribution("hud.first", "hud", 10),
      contribution("hud.third", "hud", 20),
    ]);
    expect(ordered["hud"]?.map((item) => item.extensionId)).toEqual(["hud.first", "hud.second", "hud.third"]);
  });

  it("按 slot 分组，slot 键按名称稳定排序", () => {
    const ordered = orderSlotContributions([
      contribution("panel.a", "panel", 1),
      contribution("hud.a", "hud", 2),
    ]);
    expect(Object.keys(ordered)).toEqual(["hud", "panel"]);
    expect(ordered["hud"]?.map((item) => item.extensionId)).toEqual(["hud.a"]);
  });

  it("不同 slot 可复用相同 extensionId", () => {
    const ordered = orderSlotContributions([
      contribution("shared.entry", "hud", 1),
      contribution("shared.entry", "panel", 2),
    ]);
    expect(ordered["hud"]?.length).toBe(1);
    expect(ordered["panel"]?.length).toBe(1);
  });

  it("同 slot 内 extensionId 冲突报错", () => {
    const error = expectDomainError(
      () =>
        orderSlotContributions([
          { extensionId: "hud.duplicate", slot: "hud", order: 1 },
          { extensionId: "hud.duplicate", slot: "hud", order: 2 },
        ]),
      "assembly-incompatible",
    );
    expect(error.safeMessage).toContain("hud.duplicate");
    expect(detailsText(error)).toContain("hud");
  });

  it("非法 order 报错", () => {
    expectDomainError(
      () => orderSlotContributions([{ extensionId: "hud.bad", slot: "hud", order: 1.5 }]),
      "assembly-incompatible",
    );
    expectDomainError(
      () => orderSlotContributions([{ extensionId: "hud.nan", slot: "hud", order: Number.NaN }]),
      "assembly-incompatible",
    );
  });
});
