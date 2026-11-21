/**
 * 覆盖内容视图辅助函数：派系驻地节点的回退顺序。
 * 依赖本包 game-utils 的纯函数与节点 ID 样例；不读写真实存储，也不创建模块实例。
 * 禁止在这里断言内容包字段或替代内容校验。
 */
import { describe, expect, it } from "vitest";
import { factionStandingNode } from "../src/index";

describe("factionStandingNode", () => {
  it("按党部、前哨、领地的顺序依次回退", () => {
    expect(
      factionStandingNode({ factionHomeNodeId: "grayharbor", outpostNodeId: "pass", territoryNodeId: "anchor" }),
    ).toBe("grayharbor");
    expect(factionStandingNode({ outpostNodeId: "pass", territoryNodeId: "anchor" })).toBe("pass");
    expect(factionStandingNode({ territoryNodeId: "anchor" })).toBe("anchor");
  });

  it("三类驻地都缺失时返回 undefined", () => {
    expect(factionStandingNode({})).toBeUndefined();
  });
});
