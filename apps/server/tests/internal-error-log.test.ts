/**
 * 核心职责：验证宿主内部错误日志的统一口径与 details 白名单过滤。
 * 交互契约：以可注入的 HostLogger 替身检查 logger.error 的记录内容。
 * 约束与禁忌：不启动传输层、不读文件系统；断言不得包含真实凭据或供应商报文。
 */
import { describe, expect, it } from "vitest";
import { DomainError, type HostLogger, type Json } from "@ai-npc/contracts";
import { logInternalError } from "../src/host/internal-error-log";

/** 记录 error 调用入参的 logger 替身。 */
function recordingLogger(): { readonly logger: HostLogger; readonly errors: Array<{ message: string; data?: Json }> } {
  const errors: Array<{ message: string; data?: Json }> = [];
  return {
    errors,
    logger: {
      info: () => {},
      warn: () => {},
      error: (message, data) => {
        errors.push({ message, data });
      },
    },
  };
}

describe("logInternalError", () => {
  it("领域错误记录白名单过滤后的 details，自由文本被剔除", () => {
    const { logger, errors } = recordingLogger();
    const error = new DomainError("provider-failed", "模型调用未产生可用响应", {
      details: { kind: "network-error", status: 503, note: "供应商原始报文正文" },
    });
    logInternalError(logger, "请求处理失败", error);
    expect(errors).toEqual([
      {
        message: "请求处理失败",
        data: { message: "模型调用未产生可用响应", details: { kind: "network-error", status: 503 } },
      },
    ]);
  });

  it("非领域错误只记录错误文本，不携带 details", () => {
    const { logger, errors } = recordingLogger();
    logInternalError(logger, "请求处理失败", new Error("注入失败"));
    expect(errors).toEqual([{ message: "请求处理失败", data: { message: "注入失败" } }]);
  });

  it("非 Error 值按字符串记录；details 为 null 的领域错误不带结构化内容", () => {
    const { logger, errors } = recordingLogger();
    logInternalError(logger, "WS 帧超过上限", "raw-frame");
    expect(errors).toEqual([{ message: "WS 帧超过上限", data: { message: "raw-frame" } }]);

    logInternalError(logger, "预算耗尽", new DomainError("budget-exhausted", "模型输入超过本轮窗口"));
    expect(errors[1]).toEqual({
      message: "预算耗尽",
      data: { message: "模型输入超过本轮窗口", details: null },
    });
  });

  it("logger 自身抛出异常时不向调用方传播", () => {
    const broken: HostLogger = {
      info: () => {},
      warn: () => {},
      error: () => {
        throw new Error("注入的 logger 故障");
      },
    };
    expect(() =>
      logInternalError(broken, "请求处理失败", new DomainError("provider-failed", "模型调用未产生可用响应")),
    ).not.toThrow();
  });
});
