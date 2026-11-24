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

export const streamAppendMessageSchema = z
  .object({
    type: z.literal("append"),
    channel: streamChannelSchema,
    streamSeq: z.number().int().nonnegative(),
    kind: z.enum(["dialogue", "notification", "timeline"]),
    item: jsonValueSchema,
  })
  .strict();

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

/** 服务端可推送的 WS 消息。 */
export const serverStreamMessageSchema = z.union([
  streamHelloMessageSchema,
  streamSnapshotMessageSchema,
  streamDeltaMessageSchema,
  streamAppendMessageSchema,
  streamPongMessageSchema,
  streamErrorMessageSchema,
]);

export type ServerStreamMessage = z.infer<typeof serverStreamMessageSchema>;

/** 客户端可发送的 WS 消息。 */
export const clientStreamMessageSchema = z.discriminatedUnion("type", [
  streamSubscribeMessageSchema,
  streamAckMessageSchema,
  streamPingMessageSchema,
]);

export type ClientStreamMessage = z.infer<typeof clientStreamMessageSchema>;
