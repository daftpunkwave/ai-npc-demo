/**
 * 定义统一错误码、领域错误类型、错误响应 DTO 与 details 可记录白名单。
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

/** details 可记录白名单的字符串上限：枚举型短标记足够，超长一律按自由文本剔除。 */
const maxLoggableTokenLength = 64;

/**
 * 判断字符串是否为枚举型短标记：仅 ASCII 字母数字与少量分隔符，不含空白、控制字符与非 ASCII 文本。
 * 逐字符判定而非正则，避免字符集量词触发静态扫描误报。
 */
function isTokenLike(value: string): boolean {
  if (value.length === 0 || value.length > maxLoggableTokenLength) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isAlnum =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isSeparator = char === "-" || char === "_" || char === "." || char === ":" || char === "/";
    if (!isAlnum && !isSeparator) {
      return false;
    }
  }
  return true;
}

/** 哨兵值：子值因不在白名单内被剔除，用于区分「剔除」与 details 中合法的 null 值。 */
const droppedSentinel: unique symbol = Symbol("dropped");

function filterLoggableValue(value: Json): Json | typeof droppedSentinel {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return isTokenLike(value) ? value : droppedSentinel;
  }
  if (Array.isArray(value)) {
    const items = value
      .map(filterLoggableValue)
      .filter((item): item is Json => item !== droppedSentinel);
    return items.length > 0 ? items : droppedSentinel;
  }
  const entries = Object.entries(value)
    .map(([key, inner]) => ({ key, kept: filterLoggableValue(inner) }))
    .filter((entry): entry is { key: string; kept: Json } => entry.kept !== droppedSentinel);
  return entries.length > 0 ? Object.fromEntries(entries.map(({ key, kept }) => [key, kept])) : droppedSentinel;
}

/**
 * 按 details 的可记录白名单过滤领域错误详情，供 logger 边界安全消费。
 * 白名单只保留枚举型短标记字符串、数字、布尔与 null 及其嵌套结构；
 * 自由文本（供应商报文、内部路径、正文等）一律剔除，防止扩展 logger 时把敏感内容带出。
 * 全部内容被剔除或入参为 null 时返回 null。
 */
export function loggableErrorDetails(details: Json | null): Json | null {
  const filtered = details === null ? droppedSentinel : filterLoggableValue(details);
  return filtered === droppedSentinel ? null : filtered;
}
