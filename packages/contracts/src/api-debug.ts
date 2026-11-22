/**
 * 定义控制台分支对比、调试队列、turn 重放与主动唤醒接口的 DTO。
 * 依赖 ID、JSON 与队列摘要结构；不生成证据或执行重放。
 * 禁止在此调用模型或修改世界，调试请求只描述调用范围。
 */
import { z } from "zod";
import { idSchemas } from "./ids";
import { jsonValueSchema } from "./json";
/** 分支对比：同一检查点后的结构化差异摘要。 */
export const branchDiffKindSchema = z.enum(["event", "meter", "agreement"]);

export const branchDifferenceSchema = z
  .object({
    kind: branchDiffKindSchema,
    key: z.string().min(1),
    left: jsonValueSchema,
    right: jsonValueSchema,
  })
  .strict();

export const branchCompareQuerySchema = z
  .object({
    left: z.string().min(1),
    right: z.string().min(1),
    atSeq: z.number().int().nonnegative(),
  })
  .strict();

export const branchCompareResponseSchema = z
  .object({
    left: z.string().min(1),
    right: z.string().min(1),
    atSeq: z.number().int().nonnegative(),
    differences: z.array(branchDifferenceSchema),
  })
  .strict();

export type BranchCompareResponse = z.infer<typeof branchCompareResponseSchema>;

/** 队列摘要：调度、模型池与维护队列共用。 */
export const queueSummarySchema = z
  .object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    oldestAt: z.string().min(1).nullable(),
  })
  .strict();

export const debugQueuesResponseSchema = z
  .object({
    scheduler: queueSummarySchema,
    modelPool: queueSummarySchema,
    maintenance: queueSummarySchema,
  })
  .strict();

export type DebugQueuesResponse = z.infer<typeof debugQueuesResponseSchema>;

/** 审计重放的差异项。 */
export const replayDifferenceSchema = z
  .object({
    path: z.string().min(1),
    expected: jsonValueSchema,
    actual: jsonValueSchema,
  })
  .strict();

export const turnReplayResponseSchema = z
  .object({
    requestHashMatch: z.boolean(),
    differences: z.array(replayDifferenceSchema),
  })
  .strict();

export type TurnReplayResponse = z.infer<typeof turnReplayResponseSchema>;

export const debugWakeRequestSchema = z
  .object({
    reason: z.string().min(1),
    operationId: idSchemas.op,
  })
  .strict();

export const debugWakeResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type DebugWakeResponse = z.infer<typeof debugWakeResponseSchema>;
