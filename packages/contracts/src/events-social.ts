/**
 * 定义通信、知识、协议与剧情系统事件的 payload schema。
 * 依赖领域值 schema、ID、JSON 校验与受众声明；信封字段由宿主补充。
 * 禁止在此计算送达延迟、履约结果或剧情触发，payload 只记录已提交的裁决。
 */
import { z } from "zod";
import { contentIdSchemas, idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";
import { dialogueIntentKindSchema, termSchema } from "./command-values";

/** 通信事件的投递条目：提交时冻结的逐主体送达 tick。 */
export const deliverySchema = z
  .object({
    principalId: principalIdSchema,
    deliverAtTick: z.number().int().nonnegative(),
  })
  .strict();

export type Delivery = z.infer<typeof deliverySchema>;

/** 投递名单按 principalId 排序去重，保证同一事件的冻结结果可复现。 */
export const deliveryListSchema = z.array(deliverySchema).superRefine((deliveries, context) => {
  for (let index = 1; index < deliveries.length; index += 1) {
    const previous = deliveries[index - 1];
    // eslint-disable-next-line security/detect-object-injection -- 数组下标来自本文件循环。
    const current = deliveries[index];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
    if (previous !== undefined && current !== undefined && previous.principalId >= current.principalId) {
      context.addIssue({
        code: "custom",
        message: "投递名单必须按 principalId 严格递增排序且不重复",
        path: [index],
      });
    }
  }
});

export const delegationCreatedPayloadSchema = z
  .object({
    delegationId: idSchemas.del,
    grantorFactionId: z.string().min(1),
    granteeId: principalIdSchema,
    teamIds: z.array(contentIdSchemas.team).min(1),
    // null 表示只委托队伍，不创建库存动用权。
    stockpileId: contentIdSchemas.sp.nullable(),
    maxDraw: z
      .object({
        supply: z.number().int().nonnegative(),
        energy: z.number().int().nonnegative(),
        medical: z.number().int().nonnegative(),
      })
      .strict(),
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

export const knowledgeGrantedPayloadSchema = z
  .object({
    grantId: idSchemas.kg,
    principalId: principalIdSchema,
    itemId: z.string().min(1),
    via: z.enum(["start", "share", "discovery", "setup"]),
  })
  .strict();

export const messageChannelSchema = z.enum(["message", "broadcast", "seat", "opening"]);

export type MessageChannel = z.infer<typeof messageChannelSchema>;

/** 消息意图：对白意图之外还有不经过模型的 scripted 与剧情卡 scenario。 */
export const messageIntentKindSchema = z.union([
  dialogueIntentKindSchema,
  z.enum(["scripted", "scenario"]),
]);

export type MessageIntentKind = z.infer<typeof messageIntentKindSchema>;

export const messageSentPayloadSchema = z
  .object({
    messageId: idSchemas.msg,
    fromId: principalIdSchema,
    to: z.array(principalIdSchema).min(1),
    channel: messageChannelSchema,
    text: z.string().min(1),
    deliveries: deliveryListSchema,
    intentKind: messageIntentKindSchema,
    speechArtifactRef: idSchemas.art.nullable(),
  })
  .strict();

export const dialogueChannelSchema = z.enum(["face-to-face", "relay"]);

export type DialogueChannel = z.infer<typeof dialogueChannelSchema>;

export const dialogueSubmittedPayloadSchema = z
  .object({
    dialogueId: idSchemas.dlg,
    conversationId: idSchemas.conv,
    speakerId: principalIdSchema,
    audience: z.array(principalIdSchema).min(1),
    text: z.string().min(1),
    channel: dialogueChannelSchema,
    deliveries: deliveryListSchema,
    replyToId: idSchemas.dlg.nullable(),
  })
  .strict();

export const informationSharedPayloadSchema = z
  .object({
    shareId: idSchemas.shr,
    fromId: principalIdSchema,
    evidenceId: contentIdSchemas.ev,
    audience: z.array(principalIdSchema).min(1),
    deliveries: deliveryListSchema,
  })
  .strict();

export const rumorSpreadPayloadSchema = z
  .object({
    rumorId: idSchemas.rum,
    sourceId: contentIdSchemas.src,
    aboutIds: z.array(principalIdSchema).min(1),
    text: z.string().min(1),
  })
  .strict();

/** 叙事事实：只允许首版登记过的 factType，正文由卡片声明。 */
export const worldFactRecordedPayloadSchema = z
  .object({
    factId: idSchemas.fact,
    factType: z.literal("ConvoyDelayed"),
    payload: jsonValueSchema,
  })
  .strict();

export const agentsSummonedPayloadSchema = z
  .object({
    agentIds: z.array(principalIdSchema).min(1),
    reason: z.string().min(1),
    cardId: contentIdSchemas.card,
  })
  .strict();

export const probeAskedPayloadSchema = z
  .object({
    probeId: idSchemas.prb,
    agentId: principalIdSchema,
    askedBy: principalIdSchema,
    question: z.string().min(1),
  })
  .strict();

export const agreementProposedPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
    version: z.number().int().positive(),
    proposerId: principalIdSchema,
    parties: z.array(principalIdSchema).min(2),
    terms: z.array(termSchema).min(1),
    expiresAtTick: z.number().int().nonnegative(),
    supersedesId: idSchemas.agr.nullable(),
  })
  .strict();

export const agreementRespondedPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
    partyId: principalIdSchema,
    response: z.enum(["accept", "reject", "counter"]),
  })
  .strict();

export const agreementActivatedPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
    version: z.number().int().positive(),
    parties: z.array(principalIdSchema).min(2),
    terms: z.array(termSchema).min(1),
  })
  .strict();

/** 拒绝、过期与被替代共用关闭载荷；过期时 byId 为 null。 */
export const agreementClosedPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
    byId: principalIdSchema.nullable(),
  })
  .strict();

export const agreementTermFulfilledPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
    termIndex: z.number().int().nonnegative(),
    obligorId: principalIdSchema,
    term: termSchema,
    evidenceEventIds: z.array(idSchemas.evt),
  })
  .strict();

export const agreementFulfilledPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
  })
  .strict();

export const agreementBreachedPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
    termIndex: z.number().int().nonnegative(),
    obligorId: principalIdSchema,
    term: termSchema,
  })
  .strict();

/** 剧情卡状态事件；override 没有具体卡片，cardId 与 version 为 null。 */
export const scenarioCardEventPayloadSchema = z
  .object({
    cardId: contentIdSchemas.card.nullable(),
    version: z.number().int().positive().nullable(),
    note: z.string(),
  })
  .strict();
