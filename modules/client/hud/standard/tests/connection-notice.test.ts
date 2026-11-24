/**
 * 核心职责：验证重连提示对可变长 safeMessage 选择限宽折行样式，且空文案不触发该分支。
 * 交互契约：直接调用导出的纯函数判定类名；不渲染 DOM、不依赖浏览器环境或 CSS 计算。
 * 约束与禁忌：禁止为此引入 jsdom 等浏览器测试依赖，也不断言具体像素宽度。
 */
import { describe, expect, it } from "vitest";
import { connectionNoticeClassName } from "../src/plugin";

describe("重连提示的样式选择", () => {
  it("没有错误原因时只用基础类名，保持单行提示", () => {
    expect(connectionNoticeClassName(null)).toBe("hud-connection");
    // 空串不携带任何信息，不应被当成「有原因」而放宽布局。
    expect(connectionNoticeClassName("")).toBe("hud-connection");
  });

  it("有错误原因时追加限宽折行类名", () => {
    expect(connectionNoticeClassName("频道不可用")).toBe(
      "hud-connection hud-connection-with-reason",
    );
  });

  it("变长文案都走同一分支，不因长度改变类名", () => {
    const short = connectionNoticeClassName("会话异常");
    const long = connectionNoticeClassName("订阅被拒绝：当前角色没有该频道的访问权限，请重新登录后再试");
    expect(long).toBe(short);
    // 判定只看「有没有原因」，不依赖长度阈值，避免出现中间态样式。
    expect(long).toContain("hud-connection-with-reason");
  });
});
