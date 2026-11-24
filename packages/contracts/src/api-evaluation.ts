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

export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>;

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

export const reportProbeInvalidReasonSchema = z.enum([
  "turn-failed",
  "no-dialogue",
  "empty-answer",
  "speech-fallback",
  "model-substituted",
  "evidence-incomplete",
]);

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
    /** 无效样本按原因汇总的数量；无效样本不进入正确率分母。 */
    invalidProbeCounts: z.record(reportProbeInvalidReasonSchema, z.number().int().nonnegative()),
    behavior: z.array(reportBehaviorSchema),
    memory: reportMemorySchema,
    cost: reportCostSchema,
    latency: reportLatencySchema,
  })
  .strict();

export type RunReportResponse = z.infer<typeof runReportResponseSchema>;

/**
 * 实验标识：来自实验规格的 `experimentId`，是配置引用（如 `exp-memory-promise-v1`），
 * 不是运行期生成的 `<前缀>-<12 位 base32>` ID，因此不能复用 `idSchemas.exp`。
 */
export const experimentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "实验标识只能由字母、数字、点、下划线与连字符组成");

export const experimentCreateRequestSchema = z.union([
  z.object({ experimentSpec: z.record(z.string().min(1), jsonValueSchema) }).strict(),
  z.object({ experimentRef: z.string().min(1) }).strict(),
]);

/**
 * 实验创建响应：逐个 run 的创建状态与失败详情。
 *
 * 创建是部分可成功的——一个变体的配置问题不该掩盖其他变体已创建的事实，
 * 也不该让调用方失去定位失败项的依据。因此响应保留全部 run 的身份与状态，
 * 而不是只回一个整体失败码。
 */
export const experimentRunOutcomeSchema = z
  .object({
    runId: idSchemas.run,
    /** 真实 run 生命周期状态；重放既有实验时不能统一改写为 ready。 */
    status: z.enum(["created", "preflight-failed", "ready", "running", "paused", "completed", "failed", "invalid"]),
    errors: z.array(runValidationErrorSchema),
  })
  .strict();

export const experimentCreateResponseSchema = z
  .object({
    experimentId: experimentIdSchema,
    /** 本次请求创建的 run 标识，顺序与展开顺序一致。 */
    runIds: z.array(idSchemas.run),
    /** 与 runIds 一一对应的逐个结果；失败项在 errors 里给出逐条原因。 */
    runs: z.array(experimentRunOutcomeSchema),
    /** 预检失败的 run 数量；为 0 表示全部就绪。 */
    failedRunCount: z.number().int().nonnegative(),
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
    experimentId: experimentIdSchema,
    runs: z.array(runSummarySchema),
    cells: z.array(experimentCellSummarySchema),
  })
  .strict();

export type ExperimentDetailResponse = z.infer<typeof experimentDetailResponseSchema>;

/** run 控制请求：启动与停止都要求幂等键，与运营接口的约定一致。 */
export const runControlRequestSchema = z
  .object({
    operationId: idSchemas.op,
  })
  .strict();

/** run 控制响应：操作后的状态；状态不符时返回 409 而不是伪装成功。 */
export const runControlResponseSchema = z
  .object({
    runId: idSchemas.run,
    status: z.enum(["running", "paused"]),
  })
  .strict();

export type RunControlResponse = z.infer<typeof runControlResponseSchema>;

/** 实验列表的一项：标识与已创建的 run 数量。 */
export const experimentListEntrySchema = z
  .object({
    experimentId: experimentIdSchema,
    runCount: z.number().int().nonnegative(),
  })
  .strict();

export const experimentsListResponseSchema = z
  .object({
    experiments: z.array(experimentListEntrySchema),
  })
  .strict();

export type ExperimentsListResponse = z.infer<typeof experimentsListResponseSchema>;

export const exportRequestSchema = z
  .object({
    runId: idSchemas.run,
    redaction: z.enum(["redacted", "raw"]),
  })
  .strict();

export const exportResponseSchema = z
  .object({
    artifactId: idSchemas.art,
  })
  .strict();
