/**
 * 覆盖 slot 贡献解析、Slot 渲染顺序、未知 slot 空渲染与单个贡献的错误边界隔离。
 * 依赖本包 slot 实现、React 元素与服务端字符串渲染；不访问 DOM、网络或真实模块。
 * 禁止用整页崩溃代替隔离，或让注册顺序覆盖显式 order。
 */
import { describe, expect, it } from "vitest";
import { createElement, type ErrorInfo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ContributionBoundary,
  Slot,
  selectSlotContributions,
  type ContributionBoundaryState,
} from "../src/index";
import { contribution, expectDomainError, hostValue, renderWithHost } from "./support";

const contributions = [
  contribution("hud", "hud.b", 2, "B"),
  contribution("dialogue", "dialogue.a", 1, "D"),
  contribution("hud", "hud.a", 1, "A"),
  contribution("hud", "hud.c", 1, "C"),
];

describe("selectSlotContributions", () => {
  it("按 slot 过滤并按 order 稳定排序", () => {
    expect(selectSlotContributions(contributions, "hud").map((item) => item.extensionId)).toEqual([
      "hud.a",
      "hud.c",
      "hud.b",
    ]);
  });

  it("未知或空 slot 返回空数组", () => {
    expect(selectSlotContributions(contributions, "unknown")).toHaveLength(0);
    expect(selectSlotContributions([], "hud")).toHaveLength(0);
  });

  it("同一 slot 内重复扩展 ID 抛装配错误", () => {
    expectDomainError(
      () =>
        selectSlotContributions(
          [contribution("hud", "hud.a", 1, "A"), contribution("hud", "hud.a", 2, "B")],
          "hud",
        ),
      "assembly-incompatible",
    );
  });
});

describe("Slot", () => {
  it("按稳定顺序拼接全部贡献的渲染结果", () => {
    const markup = renderWithHost(
      hostValue({ contributions }),
      createElement(Slot, { name: "hud" }),
    );
    expect(markup).toBe("ACB");
  });

  it("未知 slot 渲染为空", () => {
    const markup = renderWithHost(
      hostValue({ contributions }),
      createElement(Slot, { name: "modal" }),
    );
    expect(markup).toBe("");
  });

  it("缺少宿主 Provider 时抛出装配错误", () => {
    expectDomainError(
      () => renderToStaticMarkup(createElement(Slot, { name: "hud" })),
      "assembly-incompatible",
    );
  });
});

describe("ContributionBoundary", () => {
  it("正常渲染子内容", () => {
    const markup = renderWithHost(
      hostValue(),
      createElement(
        ContributionBoundary,
        { extensionId: "hud.a" },
        createElement("span", null, "ok"),
      ),
    );
    expect(markup).toBe("<span>ok</span>");
  });

  it("进入失败状态后只渲染 null", () => {
    const failed: ContributionBoundaryState = ContributionBoundary.getDerivedStateFromError();
    expect(failed.failed).toBe(true);
    const boundary = new ContributionBoundary({ extensionId: "hud.a" });
    boundary.state = failed;
    expect(boundary.render()).toBeNull();
  });

  it("失败时上报扩展 ID 与错误", () => {
    const reported: string[] = [];
    const boundary = new ContributionBoundary({
      extensionId: "hud.a",
      onError: (error, extensionId) => {
        reported.push(`${extensionId}:${error instanceof Error ? error.message : String(error)}`);
      },
    });
    const errorInfo: ErrorInfo = { componentStack: "" };
    boundary.componentDidCatch(new Error("boom"), errorInfo);
    expect(reported).toEqual(["hud.a:boom"]);
  });
});
