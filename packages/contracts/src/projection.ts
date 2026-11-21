/**
 * 定义玩家投影与 Agent 世界视图的 Zod 契约。
 * 依赖领域值、协议条款与 ID 校验；两者都只描述已按受众裁剪后的可见状态。
 * 禁止把未授权事实、秘密、模型调用或风险抽样结果放进投影。
 */
import { z } from "zod";
import { contentIdSchemas, idSchemas, principalIdSchema } from "./ids";
import {
  escortTaskParamsSchema,
  repairTaskParamsSchema,
  rescueTaskParamsSchema,
  resourceAmountsSchema,
  roadStatusSchema,
  scoutTaskParamsSchema,
  taskParamsSchema,
  taskTypeSchema,
  termSchema,
  transportTaskParamsSchema,
  watergateAllocationSchema,
  type TaskType,
} from "./command-values";
import { commandStatusSchema, taskStatusSchema } from "./envelopes";
import { dialogueChannelSchema } from "./events-social";

/** 时钟投影。 */
export const clockModeSchema = z.enum(["running", "pausing", "paused", "resuming", "stepping"]);

export type ClockMode = z.infer<typeof clockModeSchema>;

export const clockViewSchema = z
  .object({
    worldTick: z.number().int().nonnegative(),
    day: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    mode: clockModeSchema,
    runVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ClockView = z.infer<typeof clockViewSchema>;

/** campaign 视图；outcome 只在章节评估后写入。 */
export const campaignStatusSchema = z.enum(["running", "evaluated"]);

export const campaignOutcomeSchema = z.enum(["equilibrium", "strained"]);

export type CampaignOutcome = z.infer<typeof campaignOutcomeSchema>;

export const campaignViewSchema = z
  .object({
    campaignId: idSchemas.cmp,
    factionId: z.string().min(1),
    factionName: z.string().min(1),
    commission: z.string().min(1),
    status: campaignStatusSchema,
    outcome: campaignOutcomeSchema.nullable(),
    startTick: z.number().int().nonnegative(),
  })
  .strict();

export type CampaignView = z.infer<typeof campaignViewSchema>;

/** 开局选择项：派系、首个委托与接触角色。 */
export const startOptionSchema = z
  .object({
    factionId: z.string().min(1),
    name: z.string().min(1),
    commission: z.string().min(1),
    contacts: z.array(z.object({ agentId: principalIdSchema, name: z.string().min(1) }).strict()),
  })
  .strict();

export type StartOption = z.infer<typeof startOptionSchema>;

/** 会话中的一条对白。 */
export const conversationLineSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    dialogueId: idSchemas.dlg,
    speakerId: principalIdSchema,
    speakerName: z.string().min(1),
    text: z.string().min(1),
    worldTick: z.number().int().nonnegative(),
    channel: dialogueChannelSchema,
  })
  .strict();

export type ConversationLine = z.infer<typeof conversationLineSchema>;

/** 玩家可见的地图节点。 */
export const mapNodeViewSchema = z
  .object({
    nodeId: contentIdSchemas.node,
    name: z.string().min(1),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    facilities: z.array(z.string().min(1)),
  })
  .strict();

export type MapNodeView = z.infer<typeof mapNodeViewSchema>;

/** 玩家可见的道路：端点、行程、风险与当前状态。 */
export const mapRoadViewSchema = z
  .object({
    roadId: contentIdSchemas.r,
    fromNodeId: contentIdSchemas.node,
    toNodeId: contentIdSchemas.node,
    travelTicks: z.number().int().positive(),
    risk: z.number().int().min(0).max(2),
    status: roadStatusSchema,
  })
  .strict();

export type MapRoadView = z.infer<typeof mapRoadViewSchema>;

export const playerMapViewSchema = z
  .object({
    nodes: z.array(mapNodeViewSchema),
    roads: z.array(mapRoadViewSchema),
  })
  .strict();

export type PlayerMapView = z.infer<typeof playerMapViewSchema>;

/** 指标展示等级。 */
export const meterDisplayLevelSchema = z.enum(["critical", "strained", "stable"]);

export type MeterDisplayLevel = z.infer<typeof meterDisplayLevelSchema>;

export const meterReadingSchema = z
  .object({
    value: z.number(),
    level: meterDisplayLevelSchema,
  })
  .strict();

export type MeterReading = z.infer<typeof meterReadingSchema>;

export const playerMetersViewSchema = z
  .object({
    relayStability: meterReadingSchema,
    orchardWater: meterReadingSchema,
    migrationSafety: meterReadingSchema,
    watergateAllocation: watergateAllocationSchema,
  })
  .strict();

export type PlayerMetersView = z.infer<typeof playerMetersViewSchema>;

/** 库存资源等级（规则第 3 节）：短缺、可维持、有余量；与局势指标的展示等级不同。 */
export const resourceLevelSchema = z.enum(["scarce", "adequate", "surplus"]);

export type ResourceLevel = z.infer<typeof resourceLevelSchema>;

/** 委托余额：按资源记录剩余可动用数量。 */
export const delegationBalanceSchema = z
  .object({
    remaining: resourceAmountsSchema,
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

export type DelegationBalance = z.infer<typeof delegationBalanceSchema>;

/** 库存点视图：等级公开，精确数量与委托余额只对受托主体给出。 */
export const stockpileViewSchema = z
  .object({
    stockpileId: contentIdSchemas.sp,
    nodeId: contentIdSchemas.node,
    ownerFactionId: z.string().min(1),
    supplyLevel: resourceLevelSchema,
    energyLevel: resourceLevelSchema,
    medicalLevel: resourceLevelSchema,
    amounts: resourceAmountsSchema.nullable(),
    delegation: delegationBalanceSchema.nullable(),
  })
  .strict();

export type StockpileView = z.infer<typeof stockpileViewSchema>;

/** 队伍状态。 */
export const teamStatusSchema = z.enum(["idle", "assigned", "traveling", "working", "recovering"]);

export type TeamStatus = z.infer<typeof teamStatusSchema>;

export const teamViewSchema = z
  .object({
    teamId: contentIdSchemas.team,
    nodeId: contentIdSchemas.node,
    ownerFactionId: z.string().min(1),
    status: teamStatusSchema,
    delegatedToMe: z.boolean(),
  })
  .strict();

export type TeamView = z.infer<typeof teamViewSchema>;

/** 角色视图：公开主张取人格 values 的第一条。 */
export const characterViewSchema = z
  .object({
    agentId: principalIdSchema,
    name: z.string().min(1),
    factionId: z.string().min(1),
    role: z.string().min(1),
    nodeId: contentIdSchemas.node,
    injured: z.boolean(),
    injuredUntilTick: z.number().int().nonnegative().nullable(),
    publicClaim: z.string().nullable(),
  })
  .strict();

export type CharacterView = z.infer<typeof characterViewSchema>;

const taskParamsSchemaByType = {
  transport: transportTaskParamsSchema,
  escort: escortTaskParamsSchema,
  rescue: rescueTaskParamsSchema,
  repair: repairTaskParamsSchema,
  scout: scoutTaskParamsSchema,
} as const;

/**
 * 任务视图：自己的任务给出完整参数与两个状态列，其他任务只给出队伍在途与路线。
 * 参数必须与外层 taskType 匹配，避免出现脱离任务类型的自由 JSON。
 */
export const playerTaskViewSchema = z
  .object({
    kind: z.enum(["own", "other"]),
    taskId: idSchemas.task.nullable(),
    taskType: taskTypeSchema.nullable(),
    teamId: contentIdSchemas.team,
    participants: z.array(principalIdSchema),
    params: taskParamsSchema.nullable(),
    commandStatus: commandStatusSchema.nullable(),
    taskStatus: taskStatusSchema.nullable(),
    departTick: z.number().int().nonnegative().nullable(),
    nominalCompletionTick: z.number().int().nonnegative().nullable(),
    delayNoticeSent: z.boolean(),
    route: z.array(contentIdSchemas.r).nullable(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.kind === "other") {
      if (task.route === null || task.route.length === 0) {
        context.addIssue({ code: "custom", message: "其他任务必须给出在途路线", path: ["route"] });
      }
      if (task.taskId !== null || task.taskType !== null || task.params !== null) {
        context.addIssue({ code: "custom", message: "其他任务不暴露任务参数", path: ["taskId"] });
      }
      return;
    }
    if (task.taskId === null || task.taskType === null || task.params === null) {
      context.addIssue({ code: "custom", message: "自己的任务必须给出 taskId、taskType 与参数", path: ["taskId"] });
      return;
    }
    if (task.commandStatus === null || task.taskStatus === null) {
      context.addIssue({ code: "custom", message: "自己的任务必须给出受理状态与任务状态", path: ["taskStatus"] });
    }
    if (task.route !== null) {
      context.addIssue({ code: "custom", message: "自己的任务不使用在途路线字段", path: ["route"] });
    }
    const paramsSchema = taskParamsSchemaByType[task.taskType as TaskType];
    if (!paramsSchema.safeParse(task.params).success) {
      context.addIssue({ code: "custom", message: "任务参数与 taskType 不匹配", path: ["params"] });
    }
  });

export type PlayerTaskView = z.infer<typeof playerTaskViewSchema>;

/** 协议条款在玩家视图中的状态与累计进度。 */
export const agreementTermStatusSchema = z.enum(["open", "fulfilled", "breached"]);

export type AgreementTermStatus = z.infer<typeof agreementTermStatusSchema>;

export const agreementTermViewSchema = z
  .object({
    term: termSchema,
    status: agreementTermStatusSchema,
    progress: z.number().nullable(),
  })
  .strict();

export type AgreementTermView = z.infer<typeof agreementTermViewSchema>;

/** 协议生命周期状态。 */
export const agreementStatusSchema = z.enum([
  "proposed",
  "active",
  "fulfilled",
  "rejected",
  "expired",
  "superseded",
  "breached",
]);

export type AgreementStatus = z.infer<typeof agreementStatusSchema>;

export const agreementViewSchema = z
  .object({
    agreementId: idSchemas.agr,
    version: z.number().int().positive(),
    proposerId: principalIdSchema,
    parties: z.array(principalIdSchema).min(2),
    terms: z.array(agreementTermViewSchema).min(1),
    status: agreementStatusSchema,
    expiresAtTick: z.number().int().nonnegative(),
    supersedesId: idSchemas.agr.nullable(),
  })
  .strict();

export type AgreementView = z.infer<typeof agreementViewSchema>;

/** 任务邀请视图。 */
export const invitationViewSchema = z
  .object({
    invitationId: idSchemas.inv,
    taskId: idSchemas.task,
    inviteeId: principalIdSchema,
    taskType: taskTypeSchema,
    departTick: z.number().int().nonnegative(),
    response: z.enum(["accept", "decline"]).nullable(),
  })
  .strict();

export type InvitationView = z.infer<typeof invitationViewSchema>;

/** 收件项：消息、广播与传闻共用，kind 标明是否传闻。 */
export const inboxItemViewSchema = z
  .object({
    kind: z.enum(["message", "broadcast", "rumor"]),
    sourceId: principalIdSchema,
    text: z.string().min(1),
    worldTick: z.number().int().nonnegative(),
  })
  .strict();

export type InboxItemView = z.infer<typeof inboxItemViewSchema>;

/** 笔记条目：持有知识授权的证据，或亲历事件的摘要。 */
export const notebookEntryViewSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("evidence"),
      evidenceId: contentIdSchemas.ev,
      title: z.string().min(1),
      body: z.string(),
      source: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("witnessed"),
      eventId: idSchemas.evt,
      summaryZh: z.string().min(1),
      worldTick: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type NotebookEntryView = z.infer<typeof notebookEntryViewSchema>;

/** 投影规则派生的提醒。 */
export const playerNotificationViewSchema = z
  .object({
    kind: z.enum(["urgent", "deadline", "invite", "public"]),
    text: z.string().min(1),
    worldTick: z.number().int().nonnegative(),
  })
  .strict();

export type PlayerNotificationView = z.infer<typeof playerNotificationViewSchema>;

/** 玩家可见状态：字段按玩家受众裁剪，不含任何 Agent 的记忆与私有内容。 */
export const playerProjectionSchema = z
  .object({
    campaign: campaignViewSchema.nullable(),
    clock: clockViewSchema,
    map: playerMapViewSchema,
    /** 世界指标随 campaign.start 初始化；开局前没有指标，用 null 表示尚未可知。 */
    meters: playerMetersViewSchema.nullable(),
    stockpiles: z.array(stockpileViewSchema),
    teams: z.array(teamViewSchema),
    characters: z.array(characterViewSchema),
    tasks: z.array(playerTaskViewSchema),
    agreements: z.array(agreementViewSchema),
    /** 保留字段：首版规则只邀请 Agent 角色，玩家不会被邀请，因此恒为空数组。 */
    invitations: z.array(invitationViewSchema),
    conversations: z.array(conversationLineSchema),
    inbox: z.array(inboxItemViewSchema),
    notebook: z.array(notebookEntryViewSchema),
    awaitingReplyFrom: z.array(principalIdSchema),
    notifications: z.array(playerNotificationViewSchema),
  })
  .strict();

export type PlayerProjection = z.infer<typeof playerProjectionSchema>;
