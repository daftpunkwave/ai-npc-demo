/**
 * 定义统一错误码、领域错误类型与错误响应 DTO。
 * 依赖 zod 与 JSON 值类型；错误码只用于 HTTP/运行期失败，业务拒绝使用原因码。
 * 禁止在此吞掉错误、暴露内部细节或把业务拒绝伪装成错误码。
 */
import { z } from "zod";
import { jsonValueSchema, type Json } from "./json";

/** 错误码分组：请求、状态与预算、版本与并发、装配与供应商。 */
export const errorCodeGroups = {
  request: ["unauthenticated", "forbidden", "validation", "not-found"],
  state: ["paused", "not-ready", "invalid-state", "budget-exhausted", "cancelled"],
  version: ["idempotency-conflict", "version-conflict", "stale-controller", "stale-turn"],
  assembly: ["module-missing", "capability-conflict", "assembly-incompatible", "realm-violation"],
  provider: ["plugin-failed", "provider-failed"],
} as const;

export type ErrorCodeGroup = keyof typeof errorCodeGroups;

export type ErrorCode = (typeof errorCodeGroups)[ErrorCodeGroup][number];

/** 按分组顺序展开的全部错误码。 */
export const errorCodes = [
  ...errorCodeGroups.request,
  ...errorCodeGroups.state,
  ...errorCodeGroups.version,
  ...errorCodeGroups.assembly,
  ...errorCodeGroups.provider,
] as const satisfies readonly ErrorCode[];

export const errorCodeSchema = z.enum(errorCodes);

/** 判断任意字符串是否为已登记错误码。 */
export function isErrorCode(value: string): value is ErrorCode {
  return errorCodeSchema.safeParse(value).success;
}

/** 构造领域错误时的可选上下文；retryable 与 traceId 由宿主或适配器填写。 */
export interface DomainErrorOptions {
  readonly retryable?: boolean;
  readonly traceId?: string | null;
  readonly detailsArtifactRef?: string | null;
  readonly details?: Json | null;
  readonly cause?: unknown;
}

/**
 * 领域错误的唯一构造入口：错误码必须来自登记集合，消息必须是可安全外传的文案。
 * 敏感细节只写入 details 或 artifact 引用，不进入 safeMessage。
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly traceId: string | null;
  readonly detailsArtifactRef: string | null;
  readonly details: Json | null;

  constructor(code: ErrorCode, safeMessage: string, options: DomainErrorOptions = {}) {
    super(safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryable = options.retryable ?? false;
    this.traceId = options.traceId ?? null;
    this.detailsArtifactRef = options.detailsArtifactRef ?? null;
    this.details = options.details ?? null;
  }
}

/** 非 2xx 响应的统一错误载荷；detailsArtifactRef 指向受控 artifact 而非内联敏感内容。 */
export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        retryable: z.boolean(),
        safeMessage: z.string().min(1),
        traceId: z.string().min(1).nullable(),
        detailsArtifactRef: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** 仅用于构造安全错误响应的输入形状，便于调用方复用校验后的 JSON。 */
export const errorDetailSchema = z
  .object({
    code: errorCodeSchema,
    retryable: z.boolean(),
    safeMessage: z.string().min(1),
    traceId: z.string().min(1).nullable(),
    detailsArtifactRef: z.string().min(1).nullable(),
  })
  .strict();

/** 校验错误响应中的内联 details 仍必须是 JSON 值。 */
export const domainErrorDetailsSchema = jsonValueSchema;
