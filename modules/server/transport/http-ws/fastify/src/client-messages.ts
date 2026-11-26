/**
 * WS 客户端帧处理：解析消息、应答 ping/pong/ack、校验会话与频道，并按游标补发增量或完整快照。
 * 依赖连接集合、会话注册表、重放缓冲、发送器与频道准入回调；不注册连接、不维护定时器。
 * 禁止向未订阅频道推送、跨分支补发旧序号，或在会话失效后继续处理新订阅。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 类型签名参数名用于表达频道准入契约。 */
import {
  clientStreamMessageSchema,
  streamCloseCodes,
  type AuthContext,
  type StreamChannel,
} from "@world-prism/contracts";
import type { ReplayStore } from "./replay-store";
import type { SessionRegistry } from "./session-registry";
import type { SocketSender } from "./stream-delivery";
import { playerChannel, type Connection, type StreamSocket } from "./stream-types";

export interface ClientMessageDeps {
  readonly connections: ReadonlyMap<StreamSocket, Connection>;
  readonly sessions: SessionRegistry;
  readonly replay: ReplayStore;
  readonly sender: SocketSender;
  /** 按会话角色计算可订阅频道；准入裁决由传输层的策略端口完成。 */
  readonly channelsFor: (auth: AuthContext) => readonly StreamChannel[];
  /**
   * 该频道当前是否有真正的数据生产者。
   * 授权与可用性是两个独立问题：频道可能已授予角色但尚无实现，
   * 此时订阅必须显式返回 not-ready，否则客户端无法区分「未实现」与「暂无数据」。
   */
  readonly channelProvided: (channel: StreamChannel) => boolean;
  /** 当前流序号；增量补发必须与它衔接。 */
  readonly streamSeq: () => number;
}

/** 处理一帧客户端消息；未知连接、非法 JSON 与非法结构都只影响当前帧。 */
export function handleClientMessage(deps: ClientMessageDeps, socket: StreamSocket, raw: string): void {
  const connection = deps.connections.get(socket);
  if (connection === undefined) {
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    deps.sender.sendError(socket, "validation", "消息不是 JSON");
    return;
  }
  const parsed = clientStreamMessageSchema.safeParse(message);
  if (!parsed.success) {
    deps.sender.sendError(socket, "validation", "消息格式不合法");
    return;
  }
  // 会话校验先于一切帧处理：过期但尚未被清扫的会话若先走 ping/ack，
  // ack 会触发补发并拿到一份完整投影，绕过正常发布路径上的 activeSession 检查。
  const session = deps.sessions.activeSession(connection.sessionId);
  if (session === null) {
    deps.sender.close(socket, streamCloseCodes.sessionInvalid, "session expired");
    return;
  }
  const value = parsed.data;
  if (value.type === "ping") {
    deps.sender.sendMessage(socket, { type: "pong" });
    return;
  }
  if (value.type === "pong") {
    // 服务端心跳的回执：到达这里即已证明对端仍在收，存活时间戳由连接层在解析前更新。
    // 不需要额外动作，忽略它会静默把回执当成未知帧并回 error。
    return;
  }
  if (value.type === "ack") {
    // ack 只能确认自己已订阅的频道；补发前再确认一次，避免用它换取未订阅频道的内容。
    if (!connection.subscriptions.has(value.channel)) {
      deps.sender.sendError(socket, "forbidden", "频道未订阅");
      return;
    }
    // 客户端确认意味着内核缓冲大概率已排空；此时补发积压期间丢弃的快照。
    deps.sender.flushPendingSnapshot(connection);
    return;
  }
  const allowedChannels = deps.channelsFor(session.auth);
  if (!allowedChannels.includes(value.channel)) {
    deps.sender.sendError(socket, "forbidden", "频道不可用");
    return;
  }
  if (value.channel !== playerChannel && !deps.channelProvided(value.channel)) {
    // 已授权但尚无生产者的频道：拒绝订阅并明确告知，而不是接受后永远不发帧。
    deps.sender.sendError(socket, "not-ready", "频道尚未实现");
    return;
  }
  const buffer = deps.replay.ensure(connection.sessionId, value.channel);
  const replay = deps.replay.select(buffer, value.fromStreamSeq, deps.streamSeq());
  connection.subscriptions.add(value.channel);
  deps.replay.touch(connection.sessionId, value.channel);
  if (replay === null) {
    // 无可连续补发的增量时以完整快照重建基线。
    buffer.frames.length = 0;
    deps.sender.sendSnapshot(connection, value.channel);
    return;
  }
  for (const frame of replay) {
    if (!deps.sender.deliver(connection, JSON.stringify({ type: "delta", channel: value.channel, ...frame }))) {
      connection.pendingSnapshots.add(value.channel);
      break;
    }
  }
}
