/**
 * 定义通信模块拥有的会话、通信日志、知识授权与证据分享聚合状态，以及按主体/会话/序号编码的索引键。
 * 依赖 zod 与 module-sdk 的 WorldTx；只做状态校验、读取与索引键构造。
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

/** 会话聚合：参与者与下一条对白序号；对白正文按 seq 存放在 conversation-line 行聚合中。 */
export const conversationStateSchema = z
  .object({
    conversationId: z.string().min(1),
    participants: z.array(z.string().min(1)).min(1),
    lastSeq: z.number().int().nonnegative(),
  })
  .strict();

/** 会话成员索引行：状态为空对象，聚合 ID（主体 → 会话）本身携带全部信息。 */
export const conversationMembershipStateSchema = z.object({}).strict();

/** 消息投递索引行：记录消息 ID 与送达 tick，正文经消息聚合按主键读取。 */
export const messageDeliveryStateSchema = z
  .object({
    messageId: z.string().min(1),
    deliverAtTick: z.number().int().nonnegative(),
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
export type ConversationMembershipState = z.infer<typeof conversationMembershipStateSchema>;
export type MessageDeliveryState = z.infer<typeof messageDeliveryStateSchema>;
export type MessageState = z.infer<typeof messageStateSchema>;
export type KnowledgeGrantState = z.infer<typeof knowledgeGrantStateSchema>;
export type ShareState = z.infer<typeof shareStateSchema>;

/**
 * 聚合 ID 键的定长数字段宽度：tick 与 seq 补零后字典序与数值序一致，
 * 前缀范围查询才能按送达时间、提交时间或序号排序取最近的行。
 */
const SORT_KEY_WIDTH = 10;

/**
 * 索引键的字符集契约：组件必须为非空、可打印 ASCII 且不含冒号（键的分隔符）。
 * 运行 ID 与内容 ID 的契约正则已保证小写 ASCII；主体 ID 的契约只约束非空，
 * 由这里的写入期校验兜底——不满足字符集的主体在写入时显式失败，
 * 与查询前缀的同一约束保持对称，不存在写入成功却无法查询的键。
 * 排序字段（tick、seq）与排序尾段（消息、对白、条目 ID）取自小写 base32 或内容 ID，
 * 字典序与此前端口实现使用的 localeCompare 排序一致。
 */
function isPrintableAscii(value: string): boolean {
  // 逐码点扫描而非正则：字符类正则会触发 ReDoS 类静态告警，
  // 而这里的检查本就是线性扫描，显式循环语义等价且无回溯歧义。
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function assertKeyComponent(value: string, label: string): void {
  if (value.length === 0 || value.includes(":") || !isPrintableAscii(value)) {
    throw new DomainError("validation", `通信索引键的 ${label} 必须为非空可打印 ASCII 且不含冒号`, {
      details: { label, value },
    });
  }
}

/** 非负整数补零成定长字符串，使字典序与数值序一致；超出宽度直接报错。 */
function sortKey(value: number, label: string): string {
  const text = String(value);
  if (text.length > SORT_KEY_WIDTH) {
    throw new DomainError("validation", `通信索引键的 ${label} 超出排序键宽度`, {
      details: { label, value },
    });
  }
  return text.padStart(SORT_KEY_WIDTH, "0");
}

/** 会话对白行的聚合 ID：`conversationId:seq`，按会话前缀取最近 limit 条。 */
export function conversationLineKey(conversationId: string, seq: number): string {
  assertKeyComponent(conversationId, "conversationId");
  return `${conversationId}:${sortKey(seq, "seq")}`;
}

/** 会话对白行的查询前缀。 */
export function conversationLinePrefix(conversationId: string): string {
  assertKeyComponent(conversationId, "conversationId");
  return `${conversationId}:`;
}

/** 会话成员索引的聚合 ID：`principalId:conversationId`，按主体前缀枚举会话。 */
export function conversationMembershipKey(principalId: string, conversationId: string): string {
  assertKeyComponent(principalId, "principalId");
  assertKeyComponent(conversationId, "conversationId");
  return `${principalId}:${conversationId}`;
}

/** 会话成员索引的查询前缀。 */
export function conversationMembershipPrefix(principalId: string): string {
  assertKeyComponent(principalId, "principalId");
  return `${principalId}:`;
}

/**
 * 消息投递索引的聚合 ID：`principalId:deliverAtTick:committedAtTick:messageId`。
 * 字典序与收件箱的 (送达 tick, 提交 tick, 消息 ID) 排序一致，可按主体取最近 limit 条已送达消息。
 */
export function messageDeliveryKey(
  principalId: string,
  deliverAtTick: number,
  committedAtTick: number,
  messageId: string,
): string {
  assertKeyComponent(principalId, "principalId");
  assertKeyComponent(messageId, "messageId");
  return `${principalId}:${sortKey(deliverAtTick, "deliverAtTick")}:${sortKey(committedAtTick, "committedAtTick")}:${messageId}`;
}

/** 消息投递索引的查询前缀。 */
export function messageDeliveryPrefix(principalId: string): string {
  assertKeyComponent(principalId, "principalId");
  return `${principalId}:`;
}

/**
 * 已送达消息的排他上界：当前 tick 的定长排序键加 `~`（可打印 ASCII 的最大字符）。
 * 已送达行（送达 tick ≤ 当前 tick）在该键后跟 `:` 分隔符，必小于此界；
 * 未送达行的送达段定长键更大，必不小于此界。不构造 tick + 1，
 * 避免边界 tick 的排序键加一溢出定长宽度。
 */
export function messageDeliveryBefore(principalId: string, tick: number): string {
  assertKeyComponent(principalId, "principalId");
  return `${principalId}:${sortKey(tick, "tick")}~`;
}

/** 知识授权的聚合 ID：`principalId:itemId:via`，去重读取是 O(1) 主键查询。 */
export function knowledgeGrantKey(principalId: string, itemId: string, via: string): string {
  assertKeyComponent(principalId, "principalId");
  assertKeyComponent(itemId, "itemId");
  return `${principalId}:${itemId}:${via}`;
}

/** 知识授权的查询前缀；带 itemId 时只取该条目的授权。 */
export function knowledgeGrantPrefix(principalId: string, itemId?: string): string {
  assertKeyComponent(principalId, "principalId");
  return itemId === undefined ? `${principalId}:` : `${principalId}:${itemId}:`;
}

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
  return parseCommsState(aggregateType, aggregateId, record.state, schema);
}

/** 校验列表查询读出的通信聚合状态；损坏直接报错。 */
export function parseCommsState<T>(
  aggregateType: string,
  aggregateId: string,
  state: unknown,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(state);
  if (!parsed.success) {
    throw new DomainError("invalid-state", `通信聚合 ${aggregateType}:${aggregateId} 不合法`, {
      details: { aggregateType, aggregateId },
    });
  }
  return parsed.data;
}
