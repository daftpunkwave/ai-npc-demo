/**
 * 定义供应商无关的规范化模型请求、响应与传输端口。
 * 依赖 JSON 与 ID 校验；适配器只做一次尝试，重试与路由由模型池负责。
 * 禁止在此发起网络请求、读取密钥或写入供应商专有类型。
 */
/* eslint-disable no-unused-vars -- 本文件是模型传输端口契约，未使用参数只出现在接口方法签名中，名称用于表达调用契约。 */
import { z } from "zod";
import { jsonValueSchema, type Json, type JsonSchema } from "./json";
import { idSchemas, principalIdSchema } from "./ids";

/** 模型调用用途；新增类别必须先扩展契约与预检。 */
export const modelPurposeSchema = z.enum([
  "decision",
  "speech",
  "memory-maintenance",
  "compression",
  "embedding",
  "evaluation",
]);

export type Purpose = z.infer<typeof modelPurposeSchema>;

/** 已清洗并映射为线协议工具名的工具定义。 */
export const normalizedToolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    inputSchema: jsonValueSchema as z.ZodType<JsonSchema>,
  })
  .strict();

export type NormalizedTool = z.infer<typeof normalizedToolSchema>;

/** 供应商返回的工具调用；参数解析失败时 arguments 为 null 并记录原因。 */
export const normalizedToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: jsonValueSchema.nullable(),
    argumentsRaw: z.string(),
    parseError: z.string().nullable(),
  })
  .strict();

export type NormalizedToolCall = z.infer<typeof normalizedToolCallSchema>;

/** 规范化消息：user 纯文本、assistant 可带工具调用与供应商原生回放、tool 结果。 */
export const normalizedMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("user"),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string().nullable(),
      toolCalls: z.array(normalizedToolCallSchema),
      providerReplay: jsonValueSchema.nullable(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      toolCallId: z.string().min(1),
      content: z.string(),
      isError: z.boolean(),
    })
    .strict(),
]);

export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;

/** 请求的输出约定：纯文本或受 schema 约束的 JSON。 */
export const modelOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }).strict(),
  z
    .object({
      kind: z.literal("json"),
      schemaName: z.string().min(1),
      schema: jsonValueSchema as z.ZodType<JsonSchema>,
    })
    .strict(),
]);

export type ModelOutput = z.infer<typeof modelOutputSchema>;

/** 仅用于 fixture 与归档的上下文，真实适配器忽略该字段。 */
export const modelRequestContextSchema = z
  .object({
    agentId: principalIdSchema.nullable(),
    evaluatorId: principalIdSchema.nullable(),
    workRef: z.string().min(1),
    round: z.number().int().positive(),
    triggerPrincipalIds: z.array(principalIdSchema),
  })
  .strict();

export type ModelRequestContext = z.infer<typeof modelRequestContextSchema>;

/** 规范化模型请求：system 与 tools 在一个工具循环内必须保持一致，messages 只追加。 */
export const modelRequestSchema = z
  .object({
    llmCallId: idSchemas.llm,
    attemptId: idSchemas.att,
    purpose: modelPurposeSchema,
    externalModel: z.string().min(1),
    system: z.string(),
    messages: z.array(normalizedMessageSchema),
    tools: z.array(normalizedToolSchema),
    output: modelOutputSchema,
    maxOutputTokens: z.number().int().positive(),
    parameters: jsonValueSchema,
    timeoutMs: z.number().int().positive(),
    context: modelRequestContextSchema,
  })
  .strict();

export type ModelRequest = z.infer<typeof modelRequestSchema>;

/** token 用量；供应商未提供时为 null 且 estimated 标明是否估算。 */
export const modelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    estimated: z.boolean(),
  })
  .strict();

export type ModelUsage = z.infer<typeof modelUsageSchema>;

/** 线协议原文归档；不得包含凭据。 */
export const modelWireSchema = z
  .object({
    requestBody: jsonValueSchema,
    responseBody: jsonValueSchema,
  })
  .strict();

export type ModelWire = z.infer<typeof modelWireSchema>;

/** 规范化响应：fallbackUsed 如实报告供应商在同一次调用内换模型。 */
export const modelResponseSchema = z
  .object({
    finishReason: z.enum(["stop", "tool_calls", "length", "refusal"]),
    text: z.string().nullable(),
    json: jsonValueSchema.nullable(),
    jsonError: z.string().nullable(),
    toolCalls: z.array(normalizedToolCallSchema),
    providerReplay: jsonValueSchema.nullable(),
    usage: modelUsageSchema,
    servedModel: z.string().min(1).nullable(),
    providerRequestId: z.string().min(1).nullable(),
    fallbackUsed: z.boolean(),
    wire: modelWireSchema,
  })
  .strict();

export type ModelResponse = z.infer<typeof modelResponseSchema>;

/** 传输错误分类；rate-limited、timeout、network、server 可重试。 */
export const modelTransportErrorKindSchema = z.enum([
  "rate-limited",
  "timeout",
  "network",
  "server",
  "bad-request",
  "auth",
  "not-found",
  "protocol",
]);

export type ModelTransportErrorKind = z.infer<typeof modelTransportErrorKindSchema>;

export const modelTransportErrorSchema = z
  .object({
    kind: modelTransportErrorKindSchema,
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
    httpStatus: z.number().int().nullable(),
    message: z.string(),
  })
  .strict();

export type ModelTransportError = z.infer<typeof modelTransportErrorSchema>;

/** 适配器能力声明，预检时与工具、输出协议核对。 */
export const modelCapabilitiesSchema = z
  .object({
    toolCalling: z.boolean(),
    strictTools: z.boolean(),
    structuredOutput: z.enum(["json_schema", "json_object", "none"]),
    assistantReplay: z.enum(["standard", "verbatim"]),
    contextWindowTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    embedding: z.boolean(),
    embeddingDimensions: z.number().int().positive().nullable(),
  })
  .strict();

export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** 向量响应。 */
export const modelEmbeddingResponseSchema = z
  .object({
    vectors: z.array(z.array(z.number())),
    usage: z.object({ inputTokens: z.number().int().nonnegative().nullable() }).strict(),
  })
  .strict();

export type ModelEmbeddingResponse = z.infer<typeof modelEmbeddingResponseSchema>;

/**
 * 模型传输端口：每次调用只尝试一次，失败抛 ModelTransportError。
 * 端口是纯类型，不携带具体供应商的请求/响应结构。
 */
export interface ModelTransportPort {
  readonly adapterId: string;
  capabilities(modelConfig: Json): ModelCapabilities;
  complete(request: ModelRequest, credential: string | null): Promise<ModelResponse>;
  embed?(
    input: { externalModel: string; texts: readonly string[]; timeoutMs: number },
    credential: string | null,
  ): Promise<ModelEmbeddingResponse>;
}
