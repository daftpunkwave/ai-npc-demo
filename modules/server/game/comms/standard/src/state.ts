/**
 * 定义通信模块拥有的会话、知识授权与证据分享聚合状态。
 * 依赖 zod 与 module-sdk 的 WorldTx；只做状态校验与读取。
 * 禁止在这里计算送达、生成事件或写入投影。
 */
import { DomainError } from "@ai-npc/contracts";
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

export const conversationStateSchema = z
  .object({
    conversationId: z.string().min(1),
    participants: z.array(z.string().min(1)).min(1),
    lastSeq: z.number().int().nonnegative(),
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

export type ConversationState = z.infer<typeof conversationStateSchema>;
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
