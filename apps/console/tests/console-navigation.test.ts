/**
 * 核心职责：验证控制台页面排序、角色选择及缺少贡献时的导航结果。
 * 交互契约：直接调用宿主壳使用的导航计算，贡献顺序模拟模块注册顺序。
 * 约束与禁忌：不渲染页面、不访问服务端、不把导航状态视为授权。
 */
import { describe, expect, it } from "vitest";
import { consoleNavigation } from "../src/ui/console-navigation";

const contributions = [
  { extensionId: "console.z-first", order: 20, slot: "console.page", allowedRoles: ["researcher"], render: () => null },
  { extensionId: "console.a-second", order: 20, slot: "console.page", allowedRoles: ["operator", "researcher"], render: () => null },
  { extensionId: "console.start", order: 10, slot: "console.page", allowedRoles: ["operator"], render: () => null },
  { extensionId: "console.no-roles", order: 0, slot: "console.page", render: () => null },
  { extensionId: "other.slot", order: 0, slot: "hud", allowedRoles: ["operator"], render: () => null },
];

describe("控制台导航", () => {
  it("按 order 升序展示，同序页面保持注册顺序", () => {
    const navigation = consoleNavigation(contributions, "researcher", null);
    expect(navigation.pages.map(({ page, allowed }) => [page.extensionId, allowed])).toEqual([
      ["console.no-roles", false],
      ["console.start", false],
      ["console.z-first", true],
      ["console.a-second", true],
    ]);
    expect(navigation.selected?.extensionId).toBe("console.z-first");
  });

  it("角色切换后选中首个有权访问的页面，并支持后续显式选择", () => {
    const start = consoleNavigation(contributions, "operator", null);
    expect(start.selected?.extensionId).toBe("console.start");

    const research = consoleNavigation(contributions, "researcher", start.selected?.extensionId ?? null);
    expect(research.selected?.extensionId).toBe("console.z-first");
    expect(consoleNavigation(contributions, "researcher", "console.a-second").selected?.extensionId)
      .toBe("console.a-second");
    expect(consoleNavigation(contributions, "evaluator", "console.a-second").selected).toBeNull();
  });

  it("在已选贡献缺失时回到有权页面，无页面时返回空导航", () => {
    expect(consoleNavigation(contributions, "researcher", "console.removed").selected?.extensionId)
      .toBe("console.z-first");
    expect(consoleNavigation([], "operator", "console.removed")).toEqual({ pages: [], selected: null });
    expect(consoleNavigation(contributions.filter(({ slot }) => slot === "hud"), "operator", null))
      .toEqual({ pages: [], selected: null });
  });
});
