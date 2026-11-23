/**
 * 验证领域错误 details 的可记录白名单过滤：只保留短标记字符串、数字、布尔与 null 及其嵌套结构。
 * 依赖公共契约包 errors 主题的 loggableErrorDetails 导出。
 * 禁止在断言中依赖具体错误文案；自由文本样例需覆盖空白、非 ASCII 与超长三类。
 */
import { describe, expect, it } from "vitest";
import { loggableErrorDetails } from "../src/index";

describe("loggableErrorDetails", () => {
  it("保留枚举型短标记、数字、布尔与 null", () => {
    const details = {
      kind: "provider-failed",
      status: 503,
      retryable: true,
      finishReason: null,
      tags: ["budget", "backpressure"],
    };
    expect(loggableErrorDetails(details)).toEqual(details);
  });

  it("剔除自由文本字符串，包括空白、非 ASCII 与超长标记", () => {
    expect(
      loggableErrorDetails({
        note: "供应商返回了完整报文正文",
        wire: "HTTP 503 with body",
        long: "a".repeat(65),
        token: "still-kept",
      }),
    ).toEqual({ token: "still-kept" });
  });

  it("嵌套结构中被剔除的键整体移除，全部剔除或为空结构时返回 null", () => {
    expect(loggableErrorDetails({ outer: { keep: 1, drop: "free text" } })).toEqual({ outer: { keep: 1 } });
    expect(loggableErrorDetails({ list: ["ok", "dropped text"] })).toEqual({ list: ["ok"] });
    expect(loggableErrorDetails({ only: "自由文本" })).toBeNull();
    expect(loggableErrorDetails({ empty: {} })).toBeNull();
    expect(loggableErrorDetails(null)).toBeNull();
  });

  it("顶层标量直接按白名单判定", () => {
    expect(loggableErrorDetails("rate-limit")).toBe("rate-limit");
    expect(loggableErrorDetails(42)).toBe(42);
    expect(loggableErrorDetails("rate limit exceeded")).toBeNull();
  });
});
