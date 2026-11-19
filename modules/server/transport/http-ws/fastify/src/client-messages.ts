/**
 * WS 客户端帧处理：解析消息、应答 ping/ack、校验会话与频道，并按游标补发增量或完整快照。
 * 依赖连接集合、会话注册表、重放缓冲、发送器与频道准入回调；不注册连接、不维护定时器。
 * 禁止向未订阅频道推送、跨分支补发旧序号，或在会话失效后继续处理新订阅。
 */
import { clientStreamMessageSchema, type AuthContext, type StreamChannel } from "@ai-npc/contracts";
import type { ReplayStore } from "./replay-store";
import type { SessionRegistry } from "./session-registry";
import type { SocketSender } from "./stream-delivery";
import type { Connection, StreamSocket } from "./stream-types";

export interface ClientMessageDeps {
  readonly connections: ReadonlyMap<StreamSocket, Connection>;
  readonly sessions: SessionRegistry;
  readonly replay: ReplayStore;
  readonly sender: SocketSender;
  /** 按会话角色计算可订阅频道；准入裁决由传输层的策略端口完成。 */
  readonly channelsFor: (auth: AuthContext) => readonly StreamChannel[];
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
  const value = parsed.data;
  if (value.type === "ping") {
    deps.sender.sendMessage(socket, { type: "pong" });
    return;
  }
  if (value.type === "ack") {
    // 客户端确认意味着内核缓冲大概率已排空；此时补发积压期间丢弃的快照。
    deps.sender.flushPendingSnapshot(connection);
    return;
  }
  const session = deps.sessions.activeSession(connection.sessionId);
  if (session === null) {
    deps.sender.close(socket, 4401, "session expired");
    return;
  }
  if (!deps.channelsFor(session.auth).includes(value.channel)) {
    deps.sender.sendError(socket, "forbidden", "频道不可用");
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
      connection.needsSnapshot = true;
      break;
    }
  }
}
