/**
 * 定义控制台席位运营、时钟单步、快照恢复、run 申请与剧情卡接口的 DTO。
 * 依赖玩家投影、命令信封与回执、剧情卡效果与事件预览 schema。
 * 禁止在此实现租约、时钟推进或剧情效果；只在契约层描述请求与响应形状。
 */
import { z } from "zod";
import { agentWorldViewSchema } from "./agent-world-view";
import { eventPreviewSchema } from "./api";
import { cardEffectSchema, overrideEffectSchema } from "./commands";
import { commandEnvelopeSchema, commandReceiptSchema } from "./envelopes";
import { contentIdSchemas, idSchemas, principalIdSchema } from "./ids";
import {
  agreementViewSchema,
  clockViewSchema,
  invitationViewSchema,
} from "./projection";
/** 席位控制者类型：Agent 或真人。 */
export const seatControllerKindSchema = z.enum(["agent", "human"]);

export type SeatControllerKind = z.infer<typeof seatControllerKindSchema>;

export const seatViewSchema = z
  .object({
    agentId: principalIdSchema,
    controllerKind: seatControllerKindSchema,
    controllerPrincipalId: principalIdSchema,
    controllerEpoch: z.number().int().nonnegative(),
    leaseExpiresAt: z.string().min(1),
  })
  .strict();

export const seatsResponseSchema = z
  .object({
    seats: z.array(seatViewSchema),
  })
  .strict();

export type SeatsResponse = z.infer<typeof seatsResponseSchema>;

export const seatHandoverRequestSchema = z
  .object({
    operationId: idSchemas.op,
    mode: seatControllerKindSchema,
    expectedEpoch: z.number().int().nonnegative(),
    reason: z.string().min(1),
  })
  .strict();

export const seatHandoverResponseSchema = z
  .object({
    controllerEpoch: z.number().int().nonnegative(),
    controllerKind: seatControllerKindSchema,
    leaseExpiresAt: z.string().min(1),
  })
  .strict();

export const seatRenewRequestSchema = z
  .object({
    controllerEpoch: z.number().int().nonnegative(),
  })
  .strict();

export const seatRenewResponseSchema = z
  .object({
    leaseExpiresAt: z.string().min(1),
  })
  .strict();

/** 运营席位收件项：只有该身份合法获知的消息与对话。 */
export const seatInboxItemSchema = z
  .object({
    kind: z.enum(["message", "dialogue", "broadcast", "rumor"]),
    fromId: principalIdSchema,
    text: z.string().min(1),
    worldTick: z.number().int().nonnegative(),
  })
  .strict();

export const seatWorldViewResponseSchema = z
  .object({
    worldView: agentWorldViewSchema,
    inbox: z.array(seatInboxItemSchema),
    agreements: z.array(agreementViewSchema),
    invitations: z.array(invitationViewSchema),
  })
  .strict();

export type SeatWorldViewResponse = z.infer<typeof seatWorldViewResponseSchema>;

/** 运营席位提交命令直接复用命令信封；回执行使与玩家接口相同。 */
export const seatCommandRequestSchema = commandEnvelopeSchema;

/** 控制台时钟单步请求：ticks 为 1–24。 */
export const campaignStepRequestSchema = z
  .object({
    operationId: idSchemas.op,
    expectedRunVersion: z.number().int().nonnegative(),
    ticks: z.number().int().min(1).max(24),
  })
  .strict();

export const consoleSnapshotCreateRequestSchema = z
  .object({
    operationId: idSchemas.op,
    label: z.string().min(1),
  })
  .strict();

export const restoreCheckSchema = z
  .object({
    name: z.string().min(1),
    ok: z.boolean(),
    message: z.string().nullable(),
  })
  .strict();

export const restoreDryRunResponseSchema = z
  .object({
    ok: z.boolean(),
    checks: z.array(restoreCheckSchema),
  })
  .strict();

export const snapshotRestoreAppliedResponseSchema = z
  .object({
    branchId: idSchemas.br,
    clock: clockViewSchema,
  })
  .strict();

export const consoleSnapshotRestoreRequestSchema = z
  .object({
    operationId: idSchemas.op,
    snapshotId: idSchemas.snap,
    dryRun: z.boolean(),
  })
  .strict();

export const consoleSnapshotRestoreResponseSchema = z.union([
  restoreDryRunResponseSchema,
  snapshotRestoreAppliedResponseSchema,
]);

export type ConsoleSnapshotRestoreResponse = z.infer<typeof consoleSnapshotRestoreResponseSchema>;

/** 玩家的 run 申请视图。 */
export const runRequestViewSchema = z
  .object({
    requestId: idSchemas.rr,
    presetId: z.string().min(1),
    note: z.string(),
    status: z.enum(["pending", "approved", "rejected"]),
    createdAt: z.string().min(1),
  })
  .strict();

export const runRequestsResponseSchema = z
  .object({
    requests: z.array(runRequestViewSchema),
  })
  .strict();

export const runRequestDecisionRequestSchema = z
  .object({
    note: z.string(),
  })
  .strict();

export const runRequestApproveResponseSchema = z
  .object({
    runId: idSchemas.run,
  })
  .strict();

export const runRequestRejectResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

/** 剧情卡内容：与内容包中的卡片结构一致。 */
export const scenarioCardContentSchema = z
  .object({
    cardId: contentIdSchemas.card,
    version: z.number().int().positive(),
    trigger: z.object({ atTick: z.number().int().nonnegative() }).strict(),
    effects: z.array(cardEffectSchema).min(1),
  })
  .strict();

export type ScenarioCardContent = z.infer<typeof scenarioCardContentSchema>;

/** 分支内卡片状态视图。 */
export const scenarioCardViewSchema = z
  .object({
    cardId: contentIdSchemas.card,
    version: z.number().int().positive(),
    source: z.enum(["builtin", "draft"]),
    triggerAtTick: z.number().int().nonnegative(),
    effects: z.array(cardEffectSchema).min(1),
    status: z.enum(["scheduled", "triggered", "withdrawn"]).nullable(),
    triggeredAtTick: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const scenarioCardsResponseSchema = z
  .object({
    cards: z.array(scenarioCardViewSchema),
  })
  .strict();

export const scenarioDraftRequestSchema = z
  .object({
    card: scenarioCardContentSchema,
  })
  .strict();

export const scenarioDraftResponseSchema = z
  .object({
    cardId: contentIdSchemas.card,
    version: z.number().int().positive(),
  })
  .strict();

export const scenarioPreviewRequestSchema = z
  .object({
    version: z.number().int().positive(),
    atTick: z.number().int().nonnegative(),
  })
  .strict();

export const scenarioPreviewResponseSchema = z
  .object({
    events: z.array(eventPreviewSchema),
  })
  .strict();

export const scenarioPublishRequestSchema = z
  .object({
    version: z.number().int().positive(),
    triggerAtTick: z.number().int().nonnegative(),
    operationId: idSchemas.op,
  })
  .strict();

export const scenarioWithdrawRequestSchema = z
  .object({
    operationId: idSchemas.op,
  })
  .strict();

export const scenarioCompensateRequestSchema = z
  .object({
    effects: z.array(cardEffectSchema).min(1),
    note: z.string().min(1),
    operationId: idSchemas.op,
  })
  .strict();

export const scenarioOverrideRequestSchema = z
  .object({
    effects: z.array(overrideEffectSchema).min(1),
    note: z.string().min(1),
    operationId: idSchemas.op,
  })
  .strict();

/** 剧情卡写命令统一返回命令回执。 */
export const scenarioCommandResponseSchema = commandReceiptSchema;

