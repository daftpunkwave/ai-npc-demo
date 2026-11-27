/**
 * 核心职责：把 HTTP 失败响应与不符合契约的成功响应转换为登记错误码的 DomainError。
 * 交互契约：依赖公共错误码登记表与统一错误信封 schema；输入为状态码、已解析的响应体或 Zod 校验错误，输出可直接抛出的 DomainError。
 * 约束与禁忌：只使用登记表内的错误码；safeMessage 只取统一错误信封或本文件的固定文案，不拼接 statusText、响应正文或 Zod 原文。
 */
import { DomainError, errorResponseSchema, type ErrorCode } from "@world-prism/contracts";
import type { z } from "zod";

interface StatusFallback {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  readonly retryable: boolean;
}

/**
 * 没有统一错误信封时按状态码兜底，与服务端「错误码 → 状态码」映射口径一致。
 * 代理、静态资源层或框架在业务处理之前直接返回的响应不带信封，状态码是唯一可信的语义；
 * 403 必须落到 forbidden，会话失效判定只认 unauthenticated 与 forbidden。
 * 409 在服务端对应多个错误码，无信封时无法区分具体原因，取语义最宽的 invalid-state。
 * 408 由 Node 在请求期限内未收齐请求时直接返回，与客户端超时同属可重试的暂不可用。
 */
const statusFallbacks: ReadonlyMap<number, StatusFallback> = new Map([
  [400, { code: "validation", safeMessage: "请求未被服务端接受", retryable: false }],
  [401, { code: "unauthenticated", safeMessage: "会话已失效，请重新登录", retryable: false }],
  [403, { code: "forbidden", safeMessage: "当前会话无权执行该请求", retryable: false }],
  [404, { code: "not-found", safeMessage: "请求的资源不存在", retryable: false }],
  [408, { code: "not-ready", safeMessage: "请求超时，请稍后重试", retryable: true }],
  [409, { code: "invalid-state", safeMessage: "当前状态不允许该操作", retryable: false }],
  [429, { code: "budget-exhausted", safeMessage: "请求过于频繁，请稍后重试", retryable: true }],
  [503, { code: "not-ready", safeMessage: "服务暂不可用，请稍后重试", retryable: true }],
]);

const serverFailure: StatusFallback = {
  code: "plugin-failed",
  safeMessage: "服务端处理失败，请稍后重试",
  retryable: true,
};

const rejectedRequest: StatusFallback = {
  code: "validation",
  safeMessage: "请求未被服务端接受",
  retryable: false,
};

/** 非 2xx 响应：带统一错误信封时原样采用，否则按状态码兜底并在 details 记录状态码。 */
export function failedResponseError(status: number, payload: unknown): DomainError {
  const envelope = errorResponseSchema.safeParse(payload);
  if (envelope.success) {
    const { code, safeMessage, retryable, traceId, detailsArtifactRef } = envelope.data.error;
    return new DomainError(code, safeMessage, { retryable, traceId, detailsArtifactRef });
  }
  const fallback = statusFallbacks.get(status) ?? (status >= 500 ? serverFailure : rejectedRequest);
  return new DomainError(fallback.code, fallback.safeMessage, {
    retryable: fallback.retryable,
    details: { status },
  });
}

/**
 * 2xx 响应体不符合公共契约：服务端与客户端协议版本漂移。
 * 归为 plugin-failed：问题出在服务端产出的响应而非本次请求，用 validation 会让调用方误判为自己的输入有误；
 * 重试只会拿到同样的结构，因此不可重试。Zod 的字段路径与期望类型只进 details，不进 safeMessage。
 */
export function contractViolationError(status: number, error: z.ZodError): DomainError {
  return new DomainError("plugin-failed", "服务端响应不符合客户端协议，请刷新页面或联系维护者", {
    retryable: false,
    details: {
      status,
      issues: error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        message: issue.message,
      })),
    },
  });
}
