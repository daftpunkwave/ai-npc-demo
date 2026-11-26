/**
 * 核心职责：验证宿主内部错误日志的统一口径：logInternalError 的白名单过滤行为与传输应用边界的实际接线。
 * 交互契约：以可注入的 HostLogger 替身检查 logger.error 的记录内容；以最小输入图驱动 createTransportApp，
 * 捕获其传给传输工厂的 onInternalError 并验证它确实经 logInternalError 记录。
 * 约束与禁忌：不监听端口、不连存储、不提供真实凭据或供应商报文。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, type HostLogger, type Json } from "@world-prism/contracts";
import type { GameContent } from "@world-prism/module-sdk";
import type { ServerApp } from "../src/host/module-catalog";
import { logInternalError } from "../src/host/internal-error-log";
import { createTransportApp, type TransportAppInput } from "../src/host/transport-app";

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

describe("传输应用的内部错误接线", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("onInternalError 实际经 logInternalError 记录，宿主 logger 收到过滤后的 details", async () => {
    const { logger, errors } = recordingLogger();
    let captured: { readonly onInternalError?: (message: string, error: unknown) => void } = {};
    // stub 永不被调用，inject 返回值仅满足形状；ServerAppInjectResponse 的泛型 json 无法以字面量直接满足。
    const stubApp = {
      listen: async () => {},
      close: async () => {},
      inject: async () => ({ statusCode: 200, headers: {}, body: "", json: () => null }),
    } as unknown as ServerApp;
    const directory = mkdtempSync(join(tmpdir(), "world-prism-transport-log-"));
    dirs.push(directory);
    const input = {
      host: { logger },
      options: { playerToken: "player-token", consoleToken: "console-token" },
      runtime: {
        transport: {
          createApp: async (options: unknown) => {
            Object.assign(captured, options as Record<string, unknown>);
            return stubApp;
          },
        },
      },
      active: { worldId: "world-1", branchId: "branch-1" },
      reads: {},
      gameContent: { secrets: new Map() } as unknown as GameContent,
      consoleStaticDir: directory,
      disposeOnFailure: async () => {},
    } as unknown as TransportAppInput;

    const app = await createTransportApp(input);
    const error = new DomainError("provider-failed", "模型调用未产生可用响应", {
      details: { kind: "network-error", note: "供应商原始报文正文" },
    });
    captured.onInternalError?.("请求处理失败", error);

    expect(errors).toEqual([
      {
        message: "请求处理失败",
        data: { message: "模型调用未产生可用响应", details: { kind: "network-error" } },
      },
    ]);
    expect(app).toBe(stubApp);
  });
});
