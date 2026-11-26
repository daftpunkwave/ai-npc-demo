/**
 * 定义 Agent trigger、turn、记忆包、上下文产物、工具调用与决策的公共结构。
 * 依赖既有观察、记忆作用域、领域值、JSON 与 ID 契约。
 * 禁止在此执行调度、检索、模型调用或持久化。
 */
import { z } from "zod";
import { commandStatusSchema, executionStatusSchema, taskStatusSchema } from "./envelopes";
import { inputFrontierSchema, memoryScopeSchema } from "./frontier";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema, type Json } from "./json";
import { agentObservationSchema } from "./observation";
import { toolResultReasonCodeSchema } from "./reason-codes";
import { dialogueIntentSchema } from "./agent-tools";
export * from "./agent-tools";

/** trigger 只表达唤醒原因；合并、公平与冷却由调度策略决定。 */
export const agentTriggerKindSchema = z.enum([
  "player-dialogue",
  "debug",
  "probe",
  "alert",
  "task-invite",
  "agreement-proposal",
  "message",
  "scenario",
  "prospective",
  "patrol",
]);

export type AgentTriggerKind = z.infer<typeof agentTriggerKindSchema>;

export const agentTriggerSchema = z
  .object({
    triggerId: idSchemas.trg,
    agentId: principalIdSchema,
    kind: agentTriggerKindSchema,
    priority: z.number().int().nonnegative(),
    sourceRef: z.string().min(1),
    createdTick: z.number().int().nonnegative(),
    dedupeKey: z.string().min(1),
    consumedByTurnId: idSchemas.turn.nullable(),
  })
  .strict();

export type AgentTrigger = z.infer<typeof agentTriggerSchema>;

export const agentTurnStatusSchema = z.enum([
  "queued",
  "preparing",
  "waiting",
  "deciding",
  "executing",
  "speaking",
  "settling",
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
]);

export type AgentTurnStatus = z.infer<typeof agentTurnStatusSchema>;

export const agentStageEffectiveSchema = z
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

export type AgentStageEffective = z.infer<typeof agentStageEffectiveSchema>;

export const agentTurnRecordSchema = z
  .object({
    turnId: idSchemas.turn,
    runId: idSchemas.run,
    scope: memoryScopeSchema,
    agentTurnIndex: z.number().int().positive(),
    status: agentTurnStatusSchema,
    triggerIds: z.array(idSchemas.trg).min(1),
    inputFrontier: inputFrontierSchema.nullable(),
    profileHash: z.string().min(1),
    controllerEpoch: z.number().int().nonnegative(),
    turnLeaseEpoch: z.number().int().nonnegative(),
    effective: z.array(agentStageEffectiveSchema),
    terminalReason: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    endedAt: z.string().min(1).nullable(),
  })
  .strict();

export type AgentTurnRecord = z.infer<typeof agentTurnRecordSchema>;

export const agentMemoryQuerySchema = z
  .object({
    scope: memoryScopeSchema,
    revision: z.number().int().nonnegative(),
    frontier: inputFrontierSchema,
    counterpartIds: z.array(principalIdSchema),
    queryTags: z.array(z.string().min(1)),
    queryText: z.string(),
    nodeId: z.string().min(1).nullable(),
    purpose: z.enum(["decision", "speech", "memory-maintenance"]),
    audience: z.array(principalIdSchema),
    maxItems: z.number().int().nonnegative(),
    maxTokens: z.number().int().nonnegative(),
  })
  .strict();

export type AgentMemoryQuery = z.infer<typeof agentMemoryQuerySchema>;

export const relationSummarySchema = z
  .object({
    targetId: principalIdSchema,
    trust: z.number(),
    affinity: z.number(),
    wariness: z.number(),
    causes: z.array(
      z.enum([
        "fulfilled",
        "breach",
        "agreement",
        "aid",
        "invite-accepted",
        "invite-declined",
        "shared-evidence",
        "hostile-policy",
        "rumor-hostile",
        "counter-evidence",
      ]),
    ),
    reasonMemoryIds: z.array(idSchemas.mem),
  })
  .strict();

export type RelationSummary = z.infer<typeof relationSummarySchema>;

export const memoryBundleItemSchema = z
  .object({
    memoryId: idSchemas.mem,
    kind: z.enum(["episodic", "relation", "belief", "prospective", "core", "public"]),
    epistemic: z.enum(["verified-event", "reported-claim", "inference"]),
    summaryZh: z.string().min(1),
    validFromTick: z.number().int().nonnegative(),
    score: z.number(),
    mustInclude: z.boolean(),
    releasePolicyId: z.string().min(1),
    sourceObservationIds: z.array(idSchemas.obs),
  })
  .strict();

export type MemoryBundleItem = z.infer<typeof memoryBundleItemSchema>;

export const memoryBundleSchema = z
  .object({
    status: z.enum(["ok", "empty-by-design", "not-ready"]),
    revision: z.number().int().nonnegative(),
    coreBlock: z.string().nullable(),
    relationSummary: z.array(relationSummarySchema),
    items: z.array(memoryBundleItemSchema),
    candidates: z.number().int().nonnegative(),
    dropped: z.array(
      z
        .object({
          memoryId: idSchemas.mem,
          reason: z.enum(["budget", "dedupe", "rank"]),
        })
        .strict(),
    ),
  })
  .strict();

export type MemoryBundle = z.infer<typeof memoryBundleSchema>;

/** 整理条目被丢弃的原因；由模块产生并随任务记录保存，供审计与实验解释。 */
export const memoryMaintenanceDiscardSchema = z
  .object({
    source: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

/** 整理结果；partial 表示规则段已提交但模型段失败，水位不得推进。 */
export const memoryMaintenanceResultSchema = z
  .object({
    status: z.enum(["completed", "partial"]),
    failureReason: z.string().min(1).nullable(),
    discarded: z.array(memoryMaintenanceDiscardSchema),
  })
  .strict();

export type MemoryMaintenanceResult = z.infer<typeof memoryMaintenanceResultSchema>;

export const memoryChangePlanSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    observationSeqThrough: z.number().int().nonnegative(),
    inserts: z.array(
      z
        .object({
          memoryId: idSchemas.mem,
          kind: z.enum(["episodic", "relation", "belief", "prospective", "core", "public"]),
          tier: z.enum(["short", "long", "core", "none"]),
          status: z.enum(["active", "superseded", "expired", "evicted", "retracted"]),
          epistemic: z.enum(["verified-event", "reported-claim", "inference"]),
          releasePolicyId: z.string().min(1),
          validFromTick: z.number().int().nonnegative(),
          validUntilTick: z.number().int().nonnegative().nullable(),
          strength: z.number().nonnegative(),
          salience: z.number().min(0).max(1),
          recallCount: z.number().int().nonnegative(),
          lastReinforcedTick: z.number().int().nonnegative(),
          tags: z.array(z.string().min(1)),
          sourceObservationIds: z.array(idSchemas.obs),
          // recordUse 新建记录时必填，声明产生该记录的 turn；其他变更计划省略。
          sourceTurnId: z.string().min(1).optional(),
          /** 标记分支级公共记录；存储宿主按 ~public 单份保存。 */
          branchPublic: z.boolean().optional(),
          content: z
            .object({
              summaryZh: z.string(),
              counterpartIds: z.array(principalIdSchema),
              data: jsonValueSchema,
            })
            .strict(),
        })
        .strict(),
    ),
    retires: z.array(
      z
        .object({
          memoryId: idSchemas.mem,
          status: z.enum(["superseded", "expired", "evicted", "retracted"]),
        })
        .strict(),
    ),
    derivedThroughSeq: z.number().int().nonnegative().nullable(),
    derivedThroughTick: z.number().int().nonnegative().nullable(),
    changeKind: z.enum(["ingest", "maintenance", "use", "import"]),
    maintenanceResult: memoryMaintenanceResultSchema.optional(),
  })
  .strict();

export type MemoryChangePlan = z.infer<typeof memoryChangePlanSchema>;

export const maintenanceTaskSchema = z
  .object({
    moduleId: z.string().min(1),
    trigger: z.enum(["day-passed", "importance"]),
    dueTick: z.number().int().nonnegative(),
    baseRevision: z.number().int().nonnegative(),
    observationSeqThrough: z.number().int().nonnegative(),
    day: z.number().int().positive().nullable(),
    needsModel: z.boolean(),
    modelPriority: z.number().nonnegative().optional(),
    modelQuota: z.number().int().positive().optional(),
    modelQuotaGranted: z.boolean().optional(),
    modelCallDays: z.array(z.number().int().nonnegative()).optional(),
    rulesApplied: z.boolean().optional(),
    failureAttempts: z.number().int().nonnegative().optional(),
    retryAfterTick: z.number().int().nonnegative().optional(),
  })
  .strict();

export type MaintenanceTask = z.infer<typeof maintenanceTaskSchema>;

export const wakeupProposalSchema = z
  .object({
    atTick: z.number().int().nonnegative(),
    dedupeKey: z.string().min(1),
    reason: z.enum(["self-due", "other-due", "intent"]),
    memoryId: idSchemas.mem,
    counterpartId: principalIdSchema.nullable(),
  })
  .strict();

export type WakeupProposal = z.infer<typeof wakeupProposalSchema>;

/**
 * 上下文档的段名清单：有序段落实现与上下文构建契约共用同一份成员表。
 * user 段可以按预算裁剪，speech 段的 facts 段单独列出；新增段名必须在这里登记。
 */
export const contextUserSegmentKindValues = ["world", "task", "memory", "history", "input"] as const;

export const contextUserSegmentKindSchema = z.enum(contextUserSegmentKindValues);

export type ContextUserSegmentKind = z.infer<typeof contextUserSegmentKindSchema>;

/** 段预算允许的键：user 段 + speech 段的 facts 段。 */
export const contextSegmentKindValues = [...contextUserSegmentKindValues, "facts"] as const;

export const contextSegmentKindSchema = z.enum(contextSegmentKindValues);

export type ContextSegmentKind = z.infer<typeof contextSegmentKindSchema>;

/**
 * 段预算映射：键只接受已登记的段名，未知段名在契约入口即被拒绝。
 * 与 ordered-blocks 模块配置共用 contextSegmentKindSchema，避免一侧开放、一侧收紧。
 */
export const contextSegmentBudgetsSchema = z.partialRecord(
  contextSegmentKindSchema,
  z.number().int().nonnegative(),
);

export const contextBuildRequestSchema = z
  .object({
    session: memoryScopeSchema,
    runId: idSchemas.run,
    turnId: idSchemas.turn,
    attemptId: idSchemas.att,
    phase: z.enum(["decision", "speech"]),
    targetAudience: z.array(principalIdSchema),
    frontier: inputFrontierSchema,
    profileHash: z.string().min(1),
    templateVersion: z.string().min(1),
    systemIdentity: z.string().min(1),
    loreSummary: z.string(),
    worldViewText: z.string(),
    affairsText: z.string(),
    historyText: z.string(),
    inputText: z.string(),
    observations: z.array(agentObservationSchema),
    memoryBundle: memoryBundleSchema,
    modelWindowTokens: z.number().int().positive(),
    budget: z
      .object({
        maxInputTokens: z.number().int().positive(),
        reservedOutputTokens: z.number().int().nonnegative(),
        safetyTokens: z.number().int().nonnegative(),
        toolLoopReserveTokens: z.number().int().nonnegative(),
        segmentBudgets: contextSegmentBudgetsSchema,
        historyTurns: z.number().int().nonnegative(),
        lendUnusedBudget: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type ContextBuildRequest = z.infer<typeof contextBuildRequestSchema>;

export const contextSegmentSchema = z
  .object({
    segmentId: z.string().min(1),
    kind: z.string().min(1),
    role: z.enum(["system", "user", "tool"]),
    sourceRefs: z.array(z.string().min(1)),
    releasePolicyIds: z.array(z.string().min(1)),
    text: z.string(),
    tokenEstimate: z.number().int().nonnegative(),
    protected: z.boolean(),
  })
  .strict();

export const contextArtifactSchema = z
  .object({
    artifactId: idSchemas.art,
    parentArtifactId: idSchemas.art.nullable(),
    session: memoryScopeSchema,
    turnId: idSchemas.turn,
    phase: z.enum(["decision", "speech"]),
    frontier: inputFrontierSchema,
    profileHash: z.string().min(1),
    templateVersion: z.string().min(1),
    status: z.enum(["ready", "not-ready", "over-budget", "invalid-source", "unsupported", "failed"]),
    system: z.string(),
    segments: z.array(contextSegmentSchema),
    omissions: z.array(
      z
        .object({
          sourceRef: z.string().min(1),
          reason: z.enum(["budget", "not-disclosable", "not-in-frontier", "invalid-source"]),
        })
        .strict(),
    ),
    tokenEstimate: z.number().int().nonnegative(),
    hash: z.string().min(1),
    failureReason: z.string().min(1).nullable(),
  })
  .strict();

export type ContextArtifact = z.infer<typeof contextArtifactSchema>;

export const speechArtifactSchema = z
  .object({
    artifactId: idSchemas.art,
    turnId: idSchemas.turn,
    agentId: principalIdSchema,
    audience: z.array(principalIdSchema).min(1),
    intent: dialogueIntentSchema,
    text: z.string().min(1),
    citedRefs: z.array(z.string().min(1)),
    fallback: z.boolean(),
    validation: jsonValueSchema,
  })
  .strict();

export type SpeechArtifact = z.infer<typeof speechArtifactSchema>;

/** 模型池结果只暴露规范化响应与 attempt 摘要，不泄漏供应商类型。 */
export interface AgentModelCallResult {
  readonly response: import("./model").ModelResponse;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly status: "succeeded" | "failed" | "superseded" | "cancelled";
    readonly error: Json | null;
    readonly modelId?: string;
    readonly servedModel?: string | null;
    readonly substituted?: boolean;
  }[];
}
