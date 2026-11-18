/**
 * 定义 run 管理、评估报告、实验与导出接口的 DTO。
 * 依赖 ID 与 JSON 校验；指标、探针与成本的字段形状以评估契约为准。
 * 禁止在此计算指标或生成报告，只描述查询与返回结构。
 */
import { z } from "zod";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";
/** run 规格由配置加载边界校验，这里只约束它必须是 JSON 对象。 */
export const runSpecSchema = z.record(z.string().min(1), jsonValueSchema);

export const runValidationErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();

export const runCreateRequestSchema = z
  .object({
    runSpec: runSpecSchema,
  })
  .strict();

export const runCreateResponseSchema = z
  .object({
    runId: idSchemas.run,
    status: z.enum(["ready", "preflight-failed"]),
    errors: z.array(runValidationErrorSchema),
  })
  .strict();

export const runSummarySchema = z
  .object({
    runId: idSchemas.run,
    status: z.string().min(1),
    variant: z.string().min(1).nullable(),
    contaminated: z.boolean(),
    createdAt: z.string().min(1),
  })
  .strict();

export type RunSummary = z.infer<typeof runSummarySchema>;

export const runsQuerySchema = z
  .object({
    status: z.string().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  })
  .strict();

export const runsResponseSchema = z
  .object({
    runs: z.array(runSummarySchema),
  })
  .strict();

export const runDetailResponseSchema = z
  .object({
    runId: idSchemas.run,
    status: z.string().min(1),
    manifest: jsonValueSchema,
    manifestHash: z.string().min(1),
    contaminated: z.boolean(),
    evidenceComplete: z.boolean(),
  })
  .strict();

export const runStatusChangeRequestSchema = z
  .object({
    operationId: idSchemas.op,
  })
  .strict();

export const runStatusResponseSchema = z
  .object({
    runId: idSchemas.run,
    status: z.string().min(1),
  })
  .strict();

export const runValiditySchema = z
  .object({
    valid: z.boolean(),
    contaminated: z.boolean(),
    evidenceComplete: z.boolean(),
    invalidReasons: z.array(z.string().min(1)),
  })
  .strict();

/** 指标必须带分子与分母；无法计算的指标 value 为 null 并给出原因。 */
export const reportMetricSchema = z
  .object({
    metric: z.string().min(1),
    numerator: z.number().nullable(),
    denominator: z.number().nullable(),
    value: z.number().nullable(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const reportProbeSchema = z
  .object({
    probeId: z.string().min(1),
    agentId: principalIdSchema,
    answer: z.string(),
    score: z
      .object({
        kind: z.enum(["recall", "belief", "unknown", "secret"]),
        correct: z.boolean(),
      })
      .strict(),
    valid: z.boolean(),
    invalidReason: z.string().min(1).optional(),
  })
  .strict();

export const reportBehaviorSchema = z
  .object({
    atTick: z.number().int().nonnegative(),
    agentId: principalIdSchema,
    trigger: z.string().min(1),
    stance: z.string().min(1),
    reasonCode: z.string().min(1),
    commands: z.array(z.string().min(1)),
  })
  .strict();

export const reportMemorySchema = z
  .object({
    recordsByTier: z.record(z.string().min(1), z.number().int().nonnegative()),
    maintenanceRuns: z.number().int().nonnegative(),
    maintenanceFailures: z.number().int().nonnegative(),
  })
  .strict();

export const reportCostSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    unknownUsageAttempts: z.number().int().nonnegative(),
    costEstimate: z.number().nonnegative(),
    currency: z.string().min(1),
    pricingVersion: z.string().min(1),
  })
  .strict();

export const reportLatencySchema = z
  .object({
    turnP50Ms: z.number().nonnegative().nullable(),
    turnP95Ms: z.number().nonnegative().nullable(),
  })
  .strict();

/** run 报告：指标、探针、行为分布、记忆、成本与延迟。 */
export const runReportResponseSchema = z
  .object({
    runId: idSchemas.run,
    variant: z.string().min(1),
    scriptId: z.string().min(1),
    scriptBranch: z.string().min(1),
    validity: runValiditySchema,
    metrics: z.array(reportMetricSchema),
    probes: z.array(reportProbeSchema),
    behavior: z.array(reportBehaviorSchema),
    memory: reportMemorySchema,
    cost: reportCostSchema,
    latency: reportLatencySchema,
  })
  .strict();

export type RunReportResponse = z.infer<typeof runReportResponseSchema>;

export const experimentCreateRequestSchema = z.union([
  z.object({ experimentSpec: z.record(z.string().min(1), jsonValueSchema) }).strict(),
  z.object({ experimentRef: z.string().min(1) }).strict(),
]);

export const experimentCreateResponseSchema = z
  .object({
    experimentId: idSchemas.exp,
    runIds: z.array(idSchemas.run),
  })
  .strict();

export const experimentMetricSummarySchema = z
  .object({
    metric: z.string().min(1),
    validSamples: z.number().int().nonnegative(),
    invalidSamples: z.number().int().nonnegative(),
    mean: z.number().nullable(),
  })
  .strict();

export const experimentCellSummarySchema = z
  .object({
    variant: z.string().min(1),
    scriptBranch: z.string().min(1),
    runIds: z.array(idSchemas.run),
    metrics: z.array(experimentMetricSummarySchema),
  })
  .strict();

export const experimentDetailResponseSchema = z
  .object({
    experimentId: idSchemas.exp,
    runs: z.array(runSummarySchema),
    cells: z.array(experimentCellSummarySchema),
  })
  .strict();

export type ExperimentDetailResponse = z.infer<typeof experimentDetailResponseSchema>;

export const exportRequestSchema = z
  .object({
    runId: idSchemas.run,
    redaction: z.enum(["redacted", "raw"]),
    operationId: idSchemas.op,
  })
  .strict();

export const exportResponseSchema = z
  .object({
    artifactId: idSchemas.art,
  })
  .strict();
