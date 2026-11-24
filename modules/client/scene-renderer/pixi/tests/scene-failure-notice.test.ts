/**
 * 校验初始化失败提示的结构契约：使用 alert 角色与场景错误样式展示失败原因。
 * 依赖无 hooks 的纯展示组件；不挂载 React 或创建 DOM。
 * 禁止把失败提示退化成无角色、无原因的普通文本。
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { SceneFailureNotice } from "../src/scene-failure-notice";

describe("SceneFailureNotice", () => {
  it("以 role=alert 展示初始化失败原因", () => {
    const element = SceneFailureNotice({ reason: "WebGL 上下文创建失败" });

    expect(isValidElement(element)).toBe(true);
    const node = element as ReactElement<{
      readonly role: string;
      readonly className: string;
      readonly children: ReactNode;
    }>;
    expect(node.type).toBe("div");
    expect(node.props.role).toBe("alert");
    expect(node.props.className).toBe("scene-error");
    expect(node.props.children).toEqual(["渲染后端不可用：", "WebGL 上下文创建失败"]);
  });
});
