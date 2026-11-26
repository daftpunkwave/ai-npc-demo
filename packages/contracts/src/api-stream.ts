/**
 * 定义 WebSocket 文本帧消息：hello、subscribe、snapshot、delta、append、ack、ping/pong 与 error。
 * 依赖统一错误码、主体 ID 与 JSON 校验；服务端推送与客户端发送分别用判别联合。
 * delta 的 set 只含发生变化的顶层字段；空对象只表示版本推进（心跳），不再重发整份投影。
 * 禁止在此建立连接、管理订阅或重放缓存的增量。
 */
import { z } from "zod";
import { errorCodeSchema } from "./errors";
import { principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";
import { conversationLineSchema, playerNotificationViewSchema } from "./projection";
/** WS 频道：玩家投影、控制台健康、时间线与 turn 状态。 */
export const streamChannelSchema = z.enum(["player", "console.health", "console.timeline", "console.turns"]);

export type StreamChannel = z.infer<typeof streamChannelSchema>;

export const streamHelloMessageSchema = z
  .object({
    type: z.literal("hello"),
    protocolVersion: z.string().min(1),
    principalId: principalIdSchema,
    channels: z.array(streamChannelSchema),
  })
  .strict();

export type StreamHelloMessage = z.infer<typeof streamHelloMessageSchema>;

export const streamSubscribeMessageSchema = z
  .object({
    type: z.literal("subscribe"),
    channel: streamChannelSchema,
    fromStreamSeq: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type StreamSubscribeMessage = z.infer<typeof streamSubscribeMessageSchema>;

/**
 * 快照帧的公共字段。
 * `worldId` / `branchId` 是快照自身携带的分支身份：恢复或重开后在线分支会变，
 * 客户端必须按帧内身份更新状态并据此拒绝跨分支迟到帧，不能沿用登录时写入的常量。
 */
const streamSnapshotBaseSchema = z
  .object({
    type: z.literal("snapshot"),
    channel: streamChannelSchema,
    streamSeq: z.number().int().nonnegative(),
    worldId: z.string().min(1),
    branchId: z.string().min(1),
    data: jsonValueSchema,
  });

export const playerStreamSnapshotMessageSchema = streamSnapshotBaseSchema
  .extend({
    channel: z.literal("player"),
    projectionVersion: z.number().int().nonnegative(),
  })
  .strict();

export const consoleStreamSnapshotMessageSchema = streamSnapshotBaseSchema
  .extend({
    channel: z.enum(["console.health", "console.timeline", "console.turns"]),
    /** v1 兼容字段：非玩家快照没有投影修订号，固定为 0，不借用流序号。 */
    projectionVersion: z.literal(0),
  })
  .strict();

export const streamSnapshotMessageSchema = z.union([
  playerStreamSnapshotMessageSchema,
  consoleStreamSnapshotMessageSchema,
]);

export type StreamSnapshotMessage = z.infer<typeof streamSnapshotMessageSchema>;
export type PlayerStreamSnapshotMessage = z.infer<typeof playerStreamSnapshotMessageSchema>;
export type ConsoleStreamSnapshotMessage = z.infer<typeof consoleStreamSnapshotMessageSchema>;

/** 投影增量补丁：键为玩家投影的顶层字段名，值为该字段的新值；空对象只表示版本推进。 */
export const streamProjectionDeltaSchema = z.record(z.string().min(1), jsonValueSchema);

export type StreamProjectionDelta = z.infer<typeof streamProjectionDeltaSchema>;

export const streamDeltaMessageSchema = z
  .object({
    type: z.literal("delta"),
    channel: streamChannelSchema,
    streamSeq: z.number().int().nonnegative(),
    projectionVersion: z.number().int().nonnegative(),
    /** 只包含本次发布中发生变化的顶层字段，首次订阅与缺口由 snapshot 补齐。 */
    set: streamProjectionDeltaSchema,
  })
  .strict();

export type StreamDeltaMessage = z.infer<typeof streamDeltaMessageSchema>;

/**
 * 追加帧：按 `kind` 判别，`item` 的类型由对应视图契约固定。
 * 只声明已有生产者的两种追加（对白与提醒）；未实现的追加种类不得进入公开 schema，
 * 否则消费者无法区分“未实现”与“暂无数据”。
 */
export const streamAppendMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      type: z.literal("append"),
      channel: z.literal("player"),
      streamSeq: z.number().int().nonnegative(),
      kind: z.literal("dialogue"),
      item: conversationLineSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("append"),
      channel: z.literal("player"),
      streamSeq: z.number().int().nonnegative(),
      kind: z.literal("notification"),
      item: playerNotificationViewSchema,
    })
    .strict(),
]);

export type StreamAppendMessage = z.infer<typeof streamAppendMessageSchema>;

export const streamAckMessageSchema = z
  .object({
    type: z.literal("ack"),
    channel: streamChannelSchema,
    streamSeq: z.number().int().nonnegative(),
  })
  .strict();

export type StreamAckMessage = z.infer<typeof streamAckMessageSchema>;

export const streamPingMessageSchema = z.object({ type: z.literal("ping") }).strict();

export const streamPongMessageSchema = z.object({ type: z.literal("pong") }).strict();

export const streamErrorMessageSchema = z
  .object({
    type: z.literal("error"),
    code: errorCodeSchema,
    safeMessage: z.string().min(1),
  })
  .strict();

export type StreamErrorMessage = z.infer<typeof streamErrorMessageSchema>;

/**
 * 服务端主动关闭玩家流连接时使用的关闭码语义。
 * 4000–4999 是应用自定义区间：票据失效与会话失效的处置相反，客户端必须按码区分。
 * 票据失败是可重试的握手问题（重新申请票据再连），会话失效则必须清除本地凭据并停止重连。
 */
export const streamCloseCodes = {
  /** 会话已被注销或过期：客户端必须清除会话令牌并停止重连。 */
  sessionInvalid: 4401,
  /** 票据缺失、过期、已消费或被容量淘汰：客户端重新申请票据后即可重试。 */
  ticketInvalid: 4408,
} as const;

/** 关闭码是否只表示一次性票据不可用；该情形不得触发登出。 */
export function isTicketInvalidCloseCode(code: number): boolean {
  return code === streamCloseCodes.ticketInvalid;
}

/** 关闭码是否表示会话本身已失效；命中后必须清除本地凭据并停止重连。 */
export function isSessionInvalidCloseCode(code: number): boolean {
  return code === streamCloseCodes.sessionInvalid;
}

/**
 * 服务端可推送的 WS 消息。
 * `ping` 由服务端心跳发出，客户端须回 `pong`；两端都发心跳，因为单向心跳只能证明
 * 一方能发出帧，证明不了对端仍在收。半开连接不会有 `close` 事件，只能由这种往返探测发现。
 */
export const serverStreamMessageSchema = z.union([
  streamHelloMessageSchema,
  streamSnapshotMessageSchema,
  streamDeltaMessageSchema,
  streamAppendMessageSchema,
  streamPingMessageSchema,
  streamPongMessageSchema,
  streamErrorMessageSchema,
]);

export type ServerStreamMessage = z.infer<typeof serverStreamMessageSchema>;

/**
 * 客户端可发送的 WS 消息。
 * `pong` 是对服务端 `ping` 的回执；它与客户端主动 `ping` 是两件事：
 * 前者证明客户端仍在收，后者证明客户端仍在发。
 */
export const clientStreamMessageSchema = z.discriminatedUnion("type", [
  streamSubscribeMessageSchema,
  streamAckMessageSchema,
  streamPingMessageSchema,
  streamPongMessageSchema,
]);

export type ClientStreamMessage = z.infer<typeof clientStreamMessageSchema>;
