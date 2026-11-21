/**
 * 定义认证、会话、健康检查、玩家接口、WebSocket 消息与统一错误响应 DTO。
 * 依赖领域投影、模块装配、命令信封、错误码与 ID 校验。
 * 禁止在此实现路由、鉴权或业务逻辑；控制台接口 DTO 在 api-console 与 api-observe 中按职责拆分。
 */
import { z } from "zod";
import { audienceSpecSchema } from "./audience";
import { commandEnvelopeSchema, commandReceiptSchema, sessionRoleSchema } from "./envelopes";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";
import { realmSchema, resolvedModuleSetSchema } from "./modules";
import {
  campaignViewSchema,
  clockViewSchema,
  conversationLineSchema,
  playerProjectionSchema,
  startOptionSchema,
} from "./projection";

/** 控制台请求头 X-Active-Role 的取值。 */
export const consoleActiveRoleSchema = z.enum(["operator", "researcher", "evaluator"]);

export type ConsoleActiveRole = z.infer<typeof consoleActiveRoleSchema>;

/** 当前会话、角色、分支与两侧已解析模块集。 */
export const sessionDescriptorSchema = z
  .object({
    principalId: principalIdSchema,
    roles: z.array(sessionRoleSchema),
    worldId: z.string().min(1),
    branchId: z.string().min(1),
    protocolVersion: z.string().min(1),
    serverAssembly: resolvedModuleSetSchema,
    clientAssembly: resolvedModuleSetSchema.nullable(),
  })
  .strict();

export type SessionDescriptor = z.infer<typeof sessionDescriptorSchema>;

/** 投影信封：WS 快照/增量的版本与事件引用。 */
export const projectionEnvelopeSchema = z
  .object({
    worldId: z.string().min(1),
    branchId: z.string().min(1),
    streamSeq: z.number().int().nonnegative(),
    projectionVersion: z.number().int().nonnegative(),
    snapshotRef: z.string().min(1).nullable(),
    eventRefs: z.array(idSchemas.evt),
  })
  .strict();

export type ProjectionEnvelope = z.infer<typeof projectionEnvelopeSchema>;

/** 控制台请求上下文：scope 由服务端校验，不信任页面自报。 */
export const consoleRequestContextSchema = z
  .object({
    principalId: principalIdSchema,
    roles: z.array(z.string().min(1)),
    scope: jsonValueSchema,
    expectedEpoch: z.number().int().nonnegative().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ConsoleRequestContext = z.infer<typeof consoleRequestContextSchema>;

/** 健康检查响应，不返回内部细节。 */
export const healthResponseSchema = z
  .object({
    status: z.enum(["starting", "ready", "degraded"]),
    protocolVersion: z.string().min(1),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const loginRequestSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z
  .object({
    sessionToken: z.string().min(1),
    principalId: principalIdSchema,
    roles: z.array(sessionRoleSchema),
    expiresAt: z.string().min(1),
  })
  .strict();

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const logoutResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

export const sessionResponseSchema = sessionDescriptorSchema;

export const sessionAssemblyQuerySchema = z
  .object({
    realm: z.enum(["client", "console"]),
  })
  .strict();

export type SessionAssemblyQuery = z.infer<typeof sessionAssemblyQuerySchema>;

export const sessionAssemblyResponseSchema = resolvedModuleSetSchema;

export const streamTicketResponseSchema = z
  .object({
    ticket: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict();

export type StreamTicketResponse = z.infer<typeof streamTicketResponseSchema>;

/** 玩家开局页：当前 campaign 与可选择的开局派系。 */
export const campaignResponseSchema = z
  .object({
    campaign: campaignViewSchema.nullable(),
    starts: z.array(startOptionSchema),
  })
  .strict();

export type CampaignResponse = z.infer<typeof campaignResponseSchema>;

/** 世界视图：投影版本与完整玩家投影。 */
export const worldViewResponseSchema = z
  .object({
    streamSeq: z.number().int().nonnegative(),
    projectionVersion: z.number().int().nonnegative(),
    projection: playerProjectionSchema,
  })
  .strict();

export type WorldViewResponse = z.infer<typeof worldViewResponseSchema>;

export const conversationQuerySchema = z
  .object({
    beforeSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ConversationQuery = z.infer<typeof conversationQuerySchema>;

export const conversationResponseSchema = z
  .object({
    conversationId: idSchemas.conv,
    lines: z.array(conversationLineSchema).max(100),
  })
  .strict();

export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

/** 暂停、继续等时钟控制请求；operationId 保证重复请求返回第一次结果。 */
export const clockControlRequestSchema = z
  .object({
    operationId: idSchemas.op,
    expectedRunVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ClockControlRequest = z.infer<typeof clockControlRequestSchema>;

/**
 * 受控单步推进请求；ticks 不超过公共契约上限，时钟 provider 仍按装配的 maxStepTicks 复验。
 * 进入 stepping 后由宿主逐 tick 推进，完成后时钟回到 paused。
 */
export const clockStepRequestSchema = z
  .object({
    operationId: idSchemas.op,
    expectedRunVersion: z.number().int().nonnegative(),
    ticks: z.number().int().min(1).max(24),
  })
  .strict();

export type ClockStepRequest = z.infer<typeof clockStepRequestSchema>;

export const clockResponseSchema = clockViewSchema;

export const snapshotViewSchema = z
  .object({
    snapshotId: idSchemas.snap,
    label: z.string().min(1),
    worldTick: z.number().int().nonnegative(),
    day: z.number().int().positive(),
    createdAt: z.string().min(1),
    createdBy: principalIdSchema,
  })
  .strict();

export type SnapshotView = z.infer<typeof snapshotViewSchema>;

export const snapshotCreateRequestSchema = z
  .object({
    operationId: idSchemas.op,
    label: z.string().min(1),
  })
  .strict();

export type SnapshotCreateRequest = z.infer<typeof snapshotCreateRequestSchema>;

export const snapshotCreateResponseSchema = z
  .object({
    snapshotId: idSchemas.snap,
    worldTick: z.number().int().nonnegative(),
  })
  .strict();

export type SnapshotCreateResponse = z.infer<typeof snapshotCreateResponseSchema>;

export const snapshotListResponseSchema = z
  .object({
    snapshots: z.array(snapshotViewSchema),
  })
  .strict();

export type SnapshotListResponse = z.infer<typeof snapshotListResponseSchema>;

export const snapshotRestoreRequestSchema = z
  .object({
    operationId: idSchemas.op,
    snapshotId: idSchemas.snap,
  })
  .strict();

export type SnapshotRestoreRequest = z.infer<typeof snapshotRestoreRequestSchema>;

export const snapshotRestoreResponseSchema = z
  .object({
    branchId: idSchemas.br,
    clock: clockViewSchema,
  })
  .strict();

export type SnapshotRestoreResponse = z.infer<typeof snapshotRestoreResponseSchema>;

export const campaignResetRequestSchema = z
  .object({
    operationId: idSchemas.op,
  })
  .strict();

export type CampaignResetRequest = z.infer<typeof campaignResetRequestSchema>;

export const campaignResetResponseSchema = z
  .object({
    branchId: idSchemas.br,
  })
  .strict();

export type CampaignResetResponse = z.infer<typeof campaignResetResponseSchema>;

export const presetSummarySchema = z
  .object({
    presetId: z.string().min(1),
    title: z.string().min(1),
    summary: z.string(),
  })
  .strict();

export type PresetSummary = z.infer<typeof presetSummarySchema>;

export const presetsResponseSchema = z
  .object({
    presets: z.array(presetSummarySchema),
  })
  .strict();

export type PresetsResponse = z.infer<typeof presetsResponseSchema>;

export const runRequestCreateSchema = z
  .object({
    presetId: z.string().min(1),
    note: z.string(),
  })
  .strict();

export type RunRequestCreate = z.infer<typeof runRequestCreateSchema>;

export const runRequestCreateResponseSchema = z
  .object({
    requestId: idSchemas.rr,
    status: z.literal("pending"),
  })
  .strict();

export type RunRequestCreateResponse = z.infer<typeof runRequestCreateResponseSchema>;

/** 玩家命令提交直接复用命令信封；回执在信封模块定义。 */
export const playerCommandRequestSchema = commandEnvelopeSchema;

export const playerCommandResponseSchema = commandReceiptSchema;

/** 控制台时间线条目：真值视角的领域事件或生命周期事件。 */
export const timelineItemSchema = z
  .object({
    kind: z.enum(["domain", "lifecycle"]),
    worldSeq: z.number().int().nonnegative().nullable(),
    worldTick: z.number().int().nonnegative().nullable(),
    eventId: idSchemas.evt.nullable(),
    type: z.string().min(1),
    principalId: principalIdSchema.nullable(),
    audience: z.array(audienceSpecSchema).nullable(),
    summaryZh: z.string().min(1),
    payload: jsonValueSchema,
    correlationId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  })
  .strict();

export type TimelineItem = z.infer<typeof timelineItemSchema>;

/** 剧情卡预览的单条事件。 */
export const eventPreviewSchema = z
  .object({
    type: z.string().min(1),
    audience: z.array(audienceSpecSchema),
    payload: jsonValueSchema,
    summaryZh: z.string().min(1),
  })
  .strict();

export type EventPreview = z.infer<typeof eventPreviewSchema>;

/** 模块装配与 realm 相关的通用查询。 */
export const realmQuerySchema = z.object({ realm: realmSchema }).strict();

export type RealmQuery = z.infer<typeof realmQuerySchema>;
