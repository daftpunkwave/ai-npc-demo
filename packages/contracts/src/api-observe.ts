/**
 * 定义控制台可观测、调试、评估、run 与导出接口的 DTO。
 * 依赖时间线与投影、记忆与观察记录、turn 与错误码契约；不包含装配与剧情接口。
 * 禁止在此生成证据或评估结果，只描述已归档数据的查询与返回形状。
 */
import { z } from "zod";
import { agentWorldViewSchema } from "./agent-world-view";
import { timelineItemSchema } from "./api";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema, type Json } from "./json";
import { memoryRecordSchema } from "./memory";
import { agentObservationSchema } from "./observation";
import { inputFrontierSchema } from "./frontier";

/** 时间线查询：按分支、序号、类型与主体筛选，limit 上限 200。 */
export const timelineQuerySchema = z
  .object({
    branchId: z.string().min(1).optional(),
    fromSeq: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200),
    types: z.array(z.string().min(1)).optional(),
    agentId: principalIdSchema.optional(),
    nodeId: z.string().min(1).optional(),
  })
  .strict();

export const timelineResponseSchema = z
  .object({
    events: z.array(timelineItemSchema),
  })
  .strict();

export type TimelineResponse = z.infer<typeof timelineResponseSchema>;
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** Agent 列表项：激活状态、控制者、位置、turn 状态与水位滞后。 */
export const agentStatusViewSchema = z
  .object({
    agentId: principalIdSchema,
    kind: z.enum(["character", "strategic"]),
    active: z.boolean(),
    controllerKind: z.enum(["agent", "human"]),
    location: z.string().min(1).nullable(),
    turnStatus: z.string().min(1),
    watermarkLag: z.number().int().nonnegative(),
  })
  .strict();

export type AgentStatusView = z.infer<typeof agentStatusViewSchema>;

export const agentsResponseSchema = z
  .object({
    agents: z.array(agentStatusViewSchema),
  })
  .strict();

export type AgentsResponse = z.infer<typeof agentsResponseSchema>;

export const agentsQuerySchema = z
  .object({
    branchId: z.string().min(1),
  })
  .strict();

/** turn 摘要：状态与终止原因由运行时维护，被 Agent 检查器与 turn 查询共用。 */
export const turnSummarySchema = z
  .object({
    turnId: idSchemas.turn,
    runId: idSchemas.run,
    branchId: z.string().min(1),
    agentId: principalIdSchema,
    agentTurnIndex: z.number().int().nonnegative(),
    status: z.string().min(1),
    triggerKinds: z.array(z.string().min(1)),
    terminalReason: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    endedAt: z.string().min(1).nullable(),
    modelCalls: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    tokens: z
      .object({
        input: z.number().int().nonnegative().nullable(),
        output: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();

export type TurnSummary = z.infer<typeof turnSummarySchema>;

/** Agent 检查器中的关系与承诺摘要。 */
export const agentRelationViewSchema = z
  .object({
    targetId: principalIdSchema,
    label: z.string().min(1),
    trust: z.number().int().min(-2).max(2),
  })
  .strict();

export const agentCommitmentViewSchema = z
  .object({
    kind: z.enum(["agreement", "promise"]),
    refId: z.string().min(1),
    summary: z.string().min(1),
    dueTick: z.number().int().nonnegative().nullable(),
    state: z.string().min(1),
  })
  .strict();

export const memoryWatermarkViewSchema = z
  .object({
    observationSeq: z.number().int().nonnegative(),
    perceptionRevision: z.number().int().nonnegative(),
    memoryRevision: z.number().int().nonnegative(),
    derivedThroughTick: z.number().int().nonnegative(),
  })
  .strict();

/** Agent 检查器：人格快照、当前视图、记忆摘要、关系、承诺、水位与最近 turn。 */
export const agentInspectorResponseSchema = z
  .object({
    agentId: principalIdSchema,
    persona: jsonValueSchema,
    location: z.string().min(1).nullable(),
    worldView: agentWorldViewSchema,
    memoryRevision: z.number().int().nonnegative(),
    memoryRecords: z.array(memoryRecordSchema),
    relations: z.array(agentRelationViewSchema),
    commitments: z.array(agentCommitmentViewSchema),
    watermarks: memoryWatermarkViewSchema,
    recentTurns: z.array(turnSummarySchema),
  })
  .strict();

export type AgentInspectorResponse = z.infer<typeof agentInspectorResponseSchema>;

export const agentInspectorQuerySchema = z
  .object({
    branchId: z.string().min(1),
  })
  .strict();

export const memoryQuerySchema = z
  .object({
    branchId: z.string().min(1),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const memoryResponseSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    records: z.array(memoryRecordSchema),
  })
  .strict();

export type MemoryResponse = z.infer<typeof memoryResponseSchema>;

/** 记忆差异项：每条都带来源观察 ID。 */
export const memoryDiffEntrySchema = z
  .object({
    memoryId: idSchemas.mem,
    sourceObservationIds: z.array(idSchemas.obs),
  })
  .strict();

export const memoryDiffResponseSchema = z
  .object({
    added: z.array(memoryDiffEntrySchema),
    retired: z.array(memoryDiffEntrySchema),
    changed: z.array(memoryDiffEntrySchema),
  })
  .strict();

export type MemoryDiffResponse = z.infer<typeof memoryDiffResponseSchema>;

export const memoryDiffQuerySchema = z
  .object({
    branchId: z.string().min(1),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from > query.to) {
      context.addIssue({ code: "custom", message: "from 不能晚于 to", path: ["from"] });
    }
  });

export const observationsQuerySchema = z
  .object({
    branchId: z.string().min(1),
    fromSeq: z.number().int().nonnegative(),
    limit: z.number().int().min(1),
  })
  .strict();

export const observationsResponseSchema = z
  .object({
    observations: z.array(agentObservationSchema),
  })
  .strict();

export type ObservationsResponse = z.infer<typeof observationsResponseSchema>;

export const turnStageViewSchema = z
  .object({
    stage: z.string().min(1),
    status: z.enum(["applied", "skipped", "failed"]),
    reason: z.string().min(1).nullable(),
    requested: jsonValueSchema,
    resolved: jsonValueSchema,
    effective: jsonValueSchema,
    spanId: idSchemas.spn,
  })
  .strict();

export const turnAttemptViewSchema = z
  .object({
    attemptId: idSchemas.att,
    purpose: z.string().min(1),
    modelId: z.string().min(1),
    status: z.string().min(1),
    isEffective: z.boolean(),
    requestArtifactId: idSchemas.art.nullable(),
    responseArtifactId: idSchemas.art.nullable(),
    usage: jsonValueSchema,
    error: jsonValueSchema.nullable(),
  })
  .strict();

export const turnToolCallViewSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolId: z.string().min(1),
    executionStatus: z.enum(["ok", "error", "unknown"]).nullable(),
    commandStatus: z.enum(["accepted", "rejected"]).nullable(),
    rawArtifactId: idSchemas.art.nullable(),
    viewArtifactId: idSchemas.art.nullable(),
    operationId: idSchemas.op.nullable(),
  })
  .strict();

/** turn 详情：冻结边界、阶段、模型尝试、工具调用、决定与对白。 */
export const turnDetailSchema = turnSummarySchema
  .extend({
    inputFrontier: inputFrontierSchema.nullable(),
    memoryRevision: z.number().int().nonnegative().nullable(),
    stages: z.array(turnStageViewSchema),
    contextArtifactIds: z.array(idSchemas.art),
    attempts: z.array(turnAttemptViewSchema),
    toolCalls: z.array(turnToolCallViewSchema),
    decision: jsonValueSchema.nullable(),
    speech: z
      .object({
        speechArtifactId: idSchemas.art,
        text: z.string(),
        fallback: z.boolean(),
      })
      .strict()
      .nullable(),
    traceId: idSchemas.trc,
  })
  .strict();

export type TurnDetail = z.infer<typeof turnDetailSchema>;

export const turnsQuerySchema = z
  .object({
    runId: idSchemas.run.optional(),
    agentId: principalIdSchema.optional(),
    status: z.string().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  })
  .strict();

export const turnsResponseSchema = z
  .object({
    turns: z.array(turnSummarySchema),
  })
  .strict();

export type TurnsResponse = z.infer<typeof turnsResponseSchema>;

export const artifactQuerySchema = z
  .object({
    view: z.enum(["redacted", "raw"]),
  })
  .strict();

/** artifact 正文视图；raw 需要研究员角色并写审计事件，鉴权在路由层执行。 */
export const artifactResponseSchema = z
  .object({
    artifactId: idSchemas.art,
    view: z.enum(["redacted", "raw"]),
    body: z.string(),
  })
  .strict();

export type ArtifactResponse = z.infer<typeof artifactResponseSchema>;

/** span 树节点；children 递归表达父子关系。 */
export interface TraceSpan {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly attrs: Json;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly children: readonly TraceSpan[];
}

export const traceSpanSchema: z.ZodType<TraceSpan> = z.lazy(() =>
  z
    .object({
      spanId: idSchemas.spn,
      traceId: idSchemas.trc,
      parentSpanId: idSchemas.spn.nullable(),
      name: z.string().min(1),
      attrs: jsonValueSchema,
      startedAt: z.string().min(1),
      durationMs: z.number().nonnegative().nullable(),
      children: z.array(traceSpanSchema),
    })
    .strict(),
);

export const traceResponseSchema = z
  .object({
    traceId: idSchemas.trc,
    root: traceSpanSchema,
  })
  .strict();

export type TraceResponse = z.infer<typeof traceResponseSchema>;
