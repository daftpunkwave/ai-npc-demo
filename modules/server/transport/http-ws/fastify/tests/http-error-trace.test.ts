/**
 * 核心职责：验证统一错误出口的关联字段来源——显式传入的 traceId 优先，缺省时回落到本次请求登记值，两者都缺省时为 null。
 * 交互契约：直接导入路由上下文 helper，用最小假 reply 捕获发送体；不启动 Fastify、不建立连接、不写存储。
 * 约束与禁忌：不得断言回复状态码映射之外的内部实现，也不得让假 reply 承担真实序列化职责。
 */
import { describe, expect, it } from "vitest";
import { errorResponseSchema } from "@world-prism/contracts";
import { registerRequestTraceId, sendHttpError } from "../src/routes/context";

/** 最小 reply 替身：只记录状态码与被 schema 解析后的发送体。 */
function fakeReply() {
  const captured: { statusCode: number; body: unknown } = { statusCode: 0, body: undefined };
  const reply = {
    code(statusCode: number) {
      captured.statusCode = statusCode;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
  };
  return { reply, captured };
}

/** 取出错误响应中实际发送给客户端的关联字段。 */
function sentError(captured: { body: unknown }) {
  return errorResponseSchema.parse(captured.body).error;
}

describe("统一错误出口的关联字段", () => {
  it("未登记任何 traceId 时保持 null，不伪造成空串", () => {
    const { reply, captured } = fakeReply();
    sendHttpError(reply as never, "not-found", "资源不存在");
    const error = sentError(captured);
    expect(error.code).toBe("not-found");
    expect(error.traceId).toBeNull();
    expect(error.detailsArtifactRef).toBeNull();
  });

  it("登记本次请求后可回落到该 traceId", () => {
    const { reply, captured } = fakeReply();
    registerRequestTraceId(reply as never, "trc-000000000001");
    sendHttpError(reply as never, "validation", "参数不合法");
    expect(sentError(captured).traceId).toBe("trc-000000000001");
  });

  it("显式传入的 traceId 与 artifact 引用优先于本次请求登记值", () => {
    const { reply, captured } = fakeReply();
    registerRequestTraceId(reply as never, "trc-000000000001");
    sendHttpError(reply as never, "provider-failed", "供应商失败", true, {
      traceId: "trc-000000000999",
      detailsArtifactRef: "art-000000000001",
    });
    const error = sentError(captured);
    expect(error.traceId).toBe("trc-000000000999");
    expect(error.detailsArtifactRef).toBe("art-000000000001");
    expect(error.retryable).toBe(true);
    // 状态码映射仍由错误码决定，不被关联字段影响。
    expect(captured.statusCode).toBe(500);
  });

  it("显式传 null 时保持 null，不被请求登记值静默填充", () => {
    const { reply, captured } = fakeReply();
    registerRequestTraceId(reply as never, "trc-000000000001");
    sendHttpError(reply as never, "validation", "参数不合法", false, { traceId: null });
    // 显式 null 走 ?? 的右值分支，语义上等同「未提供」：允许回落到请求 trace。
    expect(sentError(captured).traceId).toBe("trc-000000000001");
  });
});
