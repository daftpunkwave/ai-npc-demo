/**
 * 定义 Agent trigger、turn、记忆包、上下文产物、工具调用与决策的公共结构。
 * 依赖既有观察、记忆作用域、领域值、JSON 与 ID 契约。
 * 禁止在此执行调度、检索、模型调用或持久化。
 */
import { z } from "zod";
import { inputFrontierSchema, memoryScopeSchema } from "./frontier";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema, type Json } from "./json";
import { agentObservationSchema } from "./observation";

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
        segmentBudgets: z.record(z.string().min(1), z.number().int().nonnegative()),
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

export const toolDefinitionSchema = z
  .object({
    toolId: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    effect: z.enum(["query", "command"]),
    commandType: z.string().min(1).nullable(),
    inputSchema: jsonValueSchema,
    outputSchema: jsonValueSchema,
    viewFields: z.array(z.string().min(1)),
    permissionProfile: z.string().min(1),
  })
  .strict();

export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const toolBindingSchema = z
  .object({
    bindingId: z.string().min(1),
    agentId: principalIdSchema,
    toolId: z.string().min(1),
    version: z.string().min(1),
    permissionProfile: z.string().min(1),
    maxCallsPerTurn: z.number().int().nonnegative(),
    viewConstraints: z
      .object({
        maxListItems: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type ToolBinding = z.infer<typeof toolBindingSchema>;

export const toolExecutionResultSchema = z
  .object({
    executionStatus: z.enum(["ok", "error", "unknown"]),
    commandStatus: z.enum(["accepted", "rejected"]).nullable(),
    taskStatus: z.enum(["pending", "running", "completed", "failed", "cancelled"]).nullable(),
    reasonCode: z.string().min(1).nullable(),
    receiptId: z.string().min(1).nullable(),
    operationId: z.string().min(1).nullable(),
    resultRef: z.string().min(1),
    detail: z.string(),
    data: jsonValueSchema,
  })
  .strict();

export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>;

export const dialogueIntentSchema = z
  .object({
    kind: z.enum([
      "none",
      "acknowledge",
      "answer",
      "agree",
      "refuse",
      "counter-offer",
      "request",
      "inform",
      "warn",
      "thank",
      "apologize",
      "decline-to-disclose",
      "report-result",
      "remind",
    ]),
    audience: z.array(principalIdSchema).max(4),
    tone: z.enum(["warm", "neutral", "cold", "urgent"]),
    reasonCode: z.enum([
      "none",
      "danger",
      "duty",
      "past-breach",
      "low-trust",
      "lack-resources",
      "policy",
      "need-guarantee",
      "injured",
      "busy",
    ]),
    subjectRef: z.string().min(1).nullable(),
    factRefs: z.array(z.string().min(1)).max(6),
  })
  .strict();

export type DialogueIntent = z.infer<typeof dialogueIntentSchema>;

export const noteworthySchema = z
  .object({
    kind: z.enum(["promise-by-other", "promise-by-me", "claim", "request"]),
    aboutId: principalIdSchema,
    summary: z.string().min(1).max(60),
    dueTick: z.number().int().nonnegative().nullable(),
    sourceRefs: z.array(z.string().min(1)).min(1).max(3),
  })
  .strict();

export const decisionSubmissionSchema = z
  .object({
    stance: z.enum(["accept", "decline", "negotiate", "defer", "inform", "none"]),
    dialogueIntent: dialogueIntentSchema,
    noteworthy: z.array(noteworthySchema).max(3),
    citedMemoryIds: z.array(idSchemas.mem).max(8),
    decisionNote: z.string().max(120),
  })
  .strict();

export type DecisionSubmission = z.infer<typeof decisionSubmissionSchema>;

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
  }[];
}
