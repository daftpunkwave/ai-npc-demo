/**
 * 定义通信模块拥有的会话、通信日志、知识授权与证据分享聚合状态。
 * 依赖 zod 与 module-sdk 的 WorldTx；只做状态校验与读取。
 * 禁止在这里计算送达、生成事件或写入投影。
 */
import { DomainError, messageIntentKindSchema } from "@ai-npc/contracts";
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

/** 通信日志的渠道；reported 是剧情卡以非在地来源下发的传闻。 */
export const commsMessageChannelSchema = z.enum(["message", "broadcast", "seat", "opening", "reported"]);

/** 提交时冻结的单条投递；与通信事件的 deliveries 同形。 */
export const commsDeliverySchema = z
  .object({
    principalId: z.string().min(1),
    deliverAtTick: z.number().int().nonnegative(),
  })
  .strict();

/** 一条已固化的对白；序号在会话内单调递增，投递名单按提交 tick 冻结。 */
export const conversationLineStateSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    dialogueId: z.string().min(1),
    speakerId: z.string().min(1),
    text: z.string().min(1),
    channel: z.enum(["face-to-face", "relay"]),
    worldTick: z.number().int().nonnegative(),
    deliveries: z.array(commsDeliverySchema),
  })
  .strict();

/** 会话聚合：参与者、下一条对白序号与已固化的对白；旧行没有 lines 字段时按空会话补齐。 */
export const conversationStateSchema = z
  .object({
    conversationId: z.string().min(1),
    participants: z.array(z.string().min(1)).min(1),
    lastSeq: z.number().int().nonnegative(),
    lines: z.array(conversationLineStateSchema).default([]),
  })
  .strict();

/** 通信日志聚合：正文、逐主体送达 tick 与提交 tick；conversationId 只对会话消息非空。 */
export const messageStateSchema = z
  .object({
    messageId: z.string().min(1),
    fromId: z.string().min(1),
    to: z.array(z.string().min(1)),
    channel: commsMessageChannelSchema,
    text: z.string().min(1),
    intentKind: messageIntentKindSchema,
    deliveries: z.array(commsDeliverySchema),
    committedAtTick: z.number().int().nonnegative(),
    conversationId: z.string().min(1).nullable(),
  })
  .strict();

export const knowledgeGrantStateSchema = z
  .object({
    grantId: z.string().min(1),
    principalId: z.string().min(1),
    itemId: z.string().min(1),
    via: z.enum(["start", "share", "discovery", "setup"]),
    grantedAtTick: z.number().int().nonnegative(),
  })
  .strict();

/** 一次已提交的证据分享；sharedAtTick 是分享被接受的 tick，供协议按期限复核。 */
export const shareStateSchema = z
  .object({
    shareId: z.string().min(1),
    fromId: z.string().min(1),
    evidenceId: z.string().min(1),
    audience: z.array(z.string().min(1)),
    sharedAtTick: z.number().int().nonnegative(),
  })
  .strict();

export type ConversationLineState = z.infer<typeof conversationLineStateSchema>;
export type ConversationState = z.infer<typeof conversationStateSchema>;
export type MessageState = z.infer<typeof messageStateSchema>;
export type KnowledgeGrantState = z.infer<typeof knowledgeGrantStateSchema>;
export type ShareState = z.infer<typeof shareStateSchema>;

/** 读取并校验通信聚合；缺失返回 null，损坏直接报错。 */
export function readCommsState<T>(
  tx: WorldTx,
  aggregateType: string,
  aggregateId: string,
  schema: z.ZodType<T>,
): T | null {
  const record = tx.get<unknown>(aggregateType, aggregateId);
  if (record === null) {
    return null;
  }
  const parsed = schema.safeParse(record.state);
  if (!parsed.success) {
    throw new DomainError("invalid-state", `通信聚合 ${aggregateType}:${aggregateId} 不合法`, {
      details: { aggregateType, aggregateId },
    });
  }
  return parsed.data;
}
