/**
 * 校验确定性模型 JSONL 夹具的匹配条件与响应。
 * 加载器与适配器共用 schema，异常输出可以作为协议失败输入。
 * 禁止在此加载本地文件、读取密钥或发起调用。
 */
import { z } from "zod";
import { jsonValueSchema } from "./json";
import { modelPurposeSchema, modelResponseSchema, modelTransportErrorKindSchema, modelUsageSchema } from "./model";

const fixtureToolCall = z.object({
  name: z.string().min(1).max(64),
  arguments: jsonValueSchema.optional(),
  argumentsRaw: z.string().optional(),
}).strict().refine((value) => (value.arguments === undefined) !== (value.argumentsRaw === undefined));

const fixtureResponse = z.object({
  finishReason: modelResponseSchema.shape.finishReason,
  text: z.string().nullable().optional(),
  json: jsonValueSchema.optional(),
  jsonError: z.string().nullable().optional(),
  toolCalls: z.array(fixtureToolCall).max(32).optional(),
  providerReplay: jsonValueSchema.optional(),
  usage: modelUsageSchema.nullable().optional(),
  servedModel: z.string().min(1).nullable().optional(),
  fallbackUsed: z.boolean().optional(),
  delayMs: z.number().int().nonnegative().max(120_000).optional(),
}).strict();

const fixtureFailure = z.object({
  error: z.object({
    kind: modelTransportErrorKindSchema,
    retryAfterMs: z.number().int().nonnegative().nullable().optional(),
  }).strict(),
  delayMs: z.number().int().nonnegative().max(120_000).optional(),
}).strict();

export const modelFixtureSchema = z.object({
  id: z.string().min(1),
  match: z.object({
    purpose: modelPurposeSchema,
    agentId: z.string().min(1).optional(),
    round: z.number().int().positive().optional(),
    schemaName: z.string().min(1).optional(),
    inputIncludes: z.array(z.string().min(1)).optional(),
  }).strict(),
  response: z.union([fixtureResponse, fixtureFailure]),
}).strict();

export type ModelFixture = z.infer<typeof modelFixtureSchema>;
