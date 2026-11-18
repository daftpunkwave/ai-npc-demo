/**
 * 定义命令、协议条款、剧情卡效果与事件共用的领域值 schema。
 * 依赖受众声明、ID 与 JSON 校验；命令载荷与事件载荷都复用这些值类型。
 * 禁止在此实现规则判定；数值范围与业务条件由规则模块裁决。
 */
import { z } from "zod";
import { audienceSpecSchema } from "./audience";
import { contentIdSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";

/** 三种资源 ID。 */
export const resourceIdSchema = z.enum(["supply", "energy", "medical"]);

export type ResourceId = z.infer<typeof resourceIdSchema>;

/** 完整资源量：三个字段都必填且非负，用于库存、运力与委托余额。 */
export const resourceAmountsSchema = z
  .object({
    supply: z.number().int().nonnegative(),
    energy: z.number().int().nonnegative(),
    medical: z.number().int().nonnegative(),
  })
  .strict();

export type ResourceAmounts = z.infer<typeof resourceAmountsSchema>;

/** 资源增减量：三个字段可省略，出现时允许负数，但至少给出一项。 */
export const resourceDeltaSchema = z
  .object({
    supply: z.number().int().optional(),
    energy: z.number().int().optional(),
    medical: z.number().int().optional(),
  })
  .strict()
  .superRefine((delta, context) => {
    if (delta.supply === undefined && delta.energy === undefined && delta.medical === undefined) {
      context.addIssue({ code: "custom", message: "资源增减量至少需要一个字段" });
    }
  });

export type ResourceDelta = z.infer<typeof resourceDeltaSchema>;

/** 水闸分配方案。 */
export const watergateAllocationSchema = z.enum(["harbor-first", "rotation", "orchard-first"]);

export type WatergateAllocation = z.infer<typeof watergateAllocationSchema>;

/** 道路通行状态。 */
export const roadStatusSchema = z.enum(["open", "restricted", "closed"]);

export type RoadStatus = z.infer<typeof roadStatusSchema>;

/** 可数值变化的指标 ID；水闸分配是枚举，不属于数值指标。 */
export const numericMeterIdSchema = z.enum(["relay.stability", "orchard.water", "migration.safety"]);

export type NumericMeterId = z.infer<typeof numericMeterIdSchema>;

/** 指标变化的公开原因分类，内部原因必须先映射到其中一项。 */
export const meterChangeCauseSchema = z.enum(["daily", "task", "road-risk", "group-deadline", "scenario-pressure"]);

export type MeterChangeCause = z.infer<typeof meterChangeCauseSchema>;

/** 指标变化条目。 */
export const meterChangeSchema = z
  .object({
    meter: numericMeterIdSchema,
    from: z.number(),
    to: z.number(),
    cause: meterChangeCauseSchema,
  })
  .strict();

export type MeterChange = z.infer<typeof meterChangeSchema>;

/** 指标快照：三项数值与当前水闸分配。 */
export const meterSnapshotSchema = z
  .object({
    "relay.stability": z.number(),
    "orchard.water": z.number(),
    "migration.safety": z.number(),
    "watergate.allocation": watergateAllocationSchema,
  })
  .strict();

export type MeterSnapshot = z.infer<typeof meterSnapshotSchema>;

/** 任务类型。 */
export const taskTypeSchema = z.enum(["transport", "escort", "rescue", "repair", "scout"]);

export type TaskType = z.infer<typeof taskTypeSchema>;

/** 运输任务参数。 */
export const transportTaskParamsSchema = z
  .object({
    fromStockpileId: contentIdSchemas.sp,
    toStockpileId: contentIdSchemas.sp,
    cargo: resourceAmountsSchema,
  })
  .strict();

/** 护送任务参数；durationTicks 省略时由规则取默认值。 */
export const escortTaskParamsSchema = z
  .object({
    roadId: contentIdSchemas.r,
    durationTicks: z.number().int().min(6).max(24).optional(),
  })
  .strict();

/** 救援任务参数。 */
export const rescueTaskParamsSchema = z
  .object({
    groupId: contentIdSchemas.grp,
    toNodeId: contentIdSchemas.node,
    medicalStockpileId: contentIdSchemas.sp,
  })
  .strict();

/** 修复任务参数；supplyStockpileId 可为 null 表示无需供给材料。 */
export const repairTaskParamsSchema = z
  .object({
    target: z.literal("relay"),
    energyStockpileId: contentIdSchemas.sp,
    supplyStockpileId: contentIdSchemas.sp.nullable(),
  })
  .strict();

/** 侦察任务参数。 */
export const scoutTaskParamsSchema = z
  .object({
    nodeId: contentIdSchemas.node,
  })
  .strict();

/** 任务参数联合；具体类型由外层 taskType 决定。 */
export const taskParamsSchema = z.union([
  transportTaskParamsSchema,
  escortTaskParamsSchema,
  rescueTaskParamsSchema,
  repairTaskParamsSchema,
  scoutTaskParamsSchema,
]);

export type TaskParams = z.infer<typeof taskParamsSchema>;

/** 协议条款：八种 kind 的判别联合，obligorId 为承担义务的当事人。 */
export const deliverTermSchema = z
  .object({
    kind: z.literal("deliver"),
    obligorId: principalIdSchema,
    resource: resourceIdSchema,
    amount: z.number().int().positive(),
    fromStockpileId: contentIdSchemas.sp,
    toStockpileId: contentIdSchemas.sp,
    byTick: z.number().int().nonnegative(),
  })
  .strict();

export const escortTermSchema = z
  .object({
    kind: z.literal("escort"),
    obligorId: principalIdSchema,
    roadId: contentIdSchemas.r,
    byTick: z.number().int().nonnegative(),
  })
  .strict();

export const rescueTermSchema = z
  .object({
    kind: z.literal("rescue"),
    obligorId: principalIdSchema,
    groupId: contentIdSchemas.grp,
    byTick: z.number().int().nonnegative(),
  })
  .strict();

export const repairRelayTermSchema = z
  .object({
    kind: z.literal("repair-relay"),
    obligorId: principalIdSchema,
    byTick: z.number().int().nonnegative(),
  })
  .strict();

export const shareEvidenceTermSchema = z
  .object({
    kind: z.literal("share-evidence"),
    obligorId: principalIdSchema,
    evidenceId: contentIdSchemas.ev,
    toPrincipalId: principalIdSchema,
    byTick: z.number().int().nonnegative(),
  })
  .strict();

export const grantPassageTermSchema = z
  .object({
    kind: z.literal("grant-passage"),
    obligorId: principalIdSchema,
    roadId: contentIdSchemas.r,
    granteeFactionId: z.string().min(1),
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

export const waterAllocationTermSchema = z
  .object({
    kind: z.literal("water-allocation"),
    obligorId: principalIdSchema,
    policy: watergateAllocationSchema,
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

export const delegateTermSchema = z
  .object({
    kind: z.literal("delegate"),
    obligorId: principalIdSchema,
    granteeId: principalIdSchema,
    teamIds: z.array(contentIdSchemas.team).min(1),
    stockpileId: contentIdSchemas.sp.nullable(),
    maxDraw: resourceAmountsSchema,
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

const termSchemas = [
  deliverTermSchema,
  escortTermSchema,
  rescueTermSchema,
  repairRelayTermSchema,
  shareEvidenceTermSchema,
  grantPassageTermSchema,
  waterAllocationTermSchema,
  delegateTermSchema,
] as const;

export const termSchema = z.discriminatedUnion("kind", termSchemas);

export type Term = z.infer<typeof termSchema>;
export type TermKind = Term["kind"];

/** 剧情卡效果：只允许内容包声明过的六种。 */
export const broadcastEffectSchema = z
  .object({
    kind: z.literal("broadcast"),
    speakerId: principalIdSchema,
    text: z.string().min(1),
  })
  .strict();

export const messageEffectSchema = z
  .object({
    kind: z.literal("message"),
    from: principalIdSchema,
    to: z.array(principalIdSchema).min(1),
    text: z.string().min(1),
  })
  .strict();

export const rumorEffectSchema = z
  .object({
    kind: z.literal("rumor"),
    sourceId: contentIdSchemas.src,
    aboutIds: z.array(principalIdSchema).min(1),
    text: z.string().min(1),
  })
  .strict();

export const worldFactEffectSchema = z
  .object({
    kind: z.literal("world-fact"),
    factType: z.literal("ConvoyDelayed"),
    audience: audienceSpecSchema,
    payload: jsonValueSchema,
  })
  .strict();

export const stockpileAdjustEffectSchema = z
  .object({
    kind: z.literal("stockpile-adjust"),
    stockpileId: contentIdSchemas.sp,
    delta: resourceDeltaSchema,
    reason: z.string().min(1),
  })
  .strict();

export const wakeAgentsEffectSchema = z
  .object({
    kind: z.literal("wake-agents"),
    agentIds: z.array(principalIdSchema).min(1),
    reason: z.string().min(1),
  })
  .strict();

const cardEffectSchemas = [
  broadcastEffectSchema,
  messageEffectSchema,
  rumorEffectSchema,
  worldFactEffectSchema,
  stockpileAdjustEffectSchema,
  wakeAgentsEffectSchema,
] as const;

export const cardEffectSchema = z.discriminatedUnion("kind", cardEffectSchemas);

export type CardEffect = z.infer<typeof cardEffectSchema>;
export type CardEffectKind = CardEffect["kind"];

/** 覆盖效果额外允许直接设置指标与道路状态，只供调试使用。 */
export const meterSetEffectSchema = z
  .object({
    kind: z.literal("meter-set"),
    meter: numericMeterIdSchema,
    value: z.number(),
  })
  .strict();

export const roadStatusSetEffectSchema = z
  .object({
    kind: z.literal("road-status-set"),
    roadId: contentIdSchemas.r,
    status: roadStatusSchema,
  })
  .strict();

export const overrideEffectSchema = z.discriminatedUnion("kind", [
  ...cardEffectSchemas,
  meterSetEffectSchema,
  roadStatusSetEffectSchema,
]);

export type OverrideEffect = z.infer<typeof overrideEffectSchema>;
export type OverrideEffectKind = OverrideEffect["kind"];

/** 对白意图类别，用于 speech 生成与消息事件的意图标注。 */
export const dialogueIntentKindSchema = z.enum([
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
]);

export type DialogueIntentKind = z.infer<typeof dialogueIntentKindSchema>;

/** speech.commit 可写回的渠道。 */
export const speechChannelSchema = z.enum(["dialogue", "message", "broadcast"]);

export type SpeechChannel = z.infer<typeof speechChannelSchema>;
