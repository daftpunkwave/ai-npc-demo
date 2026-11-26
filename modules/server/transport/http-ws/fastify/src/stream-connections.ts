/**
 * 核心职责：管理 WS 连接的接纳与注销：一次性票据校验、容量上限、连接计数与关闭清理。
 * 交互契约：由流中心注入会话注册表、发送器、频道判定与连接计数回调；
 * 本模块只维护连接表与会话连接计数，不计算投影增量、不管理重放缓冲。
 * 约束与禁忌：不注册监听之外的处理逻辑、不在超限时把连接放进连接表、也不吞掉清理失败。
 */
import { protocolVersion, streamCloseCodes, type StreamChannel } from "@ai-npc/contracts";
import type { SessionRegistry } from "./session-registry";
import type { SocketSender } from "./stream-delivery";
import { hubLimits, playerChannel, type Connection, type StreamHubOptions, type StreamIdentity, type StreamSession, type StreamSocket } from "./stream-types";

/** 连接接纳的注入依赖。 */
export interface ConnectionAdmissionInput {
  readonly options: StreamHubOptions;
  readonly now: () => number;
  readonly sessions: SessionRegistry;
  readonly sender: SocketSender;
  readonly branchId: () => string;
  readonly connections: Map<StreamSocket, Connection>;
  readonly sessionConnections: Map<string, number>;
  readonly playerConnections: {
    count: number;
  };
  readonly onPlayerConnectionsChanged: (connected: number) => void;
  readonly onMessage: (socket: StreamSocket, raw: string) => void;
  /** 连接关闭后释放重放缓冲并通知玩家连接数变化。 */
  readonly onDisconnected: (connection: Connection) => void;
}

/**
 * 连接接纳与注销。
 *
 * 容量检查必须在注册监听与计入计数之前：超限连接既不能占连接表记录，
 * 也不能让会话连接计数与玩家连接计数留下无对应连接的残值。
 */
export class ConnectionAdmission {
  private readonly limits: ReturnType<typeof hubLimits>;

  constructor(private readonly input: ConnectionAdmissionInput) {
    this.limits = hubLimits(input.options);
  }

  /** 消费票据并建立连接：无论校验是否通过票据都不再可用。 */
  accept(socket: StreamSocket, ticketValue: string | undefined): void {
    const { sessions, sender, connections, sessionConnections } = this.input;
    const ticket = sessions.takeTicket(ticketValue);
    if (ticket === undefined || ticket.expiresAt <= this.input.now()) {
      sender.close(socket, streamCloseCodes.ticketInvalid, "invalid ticket");
      return;
    }
    const session = sessions.activeSession(ticket.sessionId);
    if (session === null) {
      sender.close(socket, streamCloseCodes.sessionInvalid, "session expired");
      return;
    }
    // 拒绝时用 reject 而非 close：连接不在注册表内，若只发关闭帧等对端回应，
    // 半开状态下没有任何清理路径会回收它。
    if (connections.size >= this.limits.maxConnections) {
      sender.reject(socket, 1013, "too many connections");
      return;
    }
    if ((sessionConnections.get(session.sessionId) ?? 0) >= this.limits.maxConnectionsPerSession) {
      sender.reject(socket, 1013, "too many session connections");
      return;
    }
    const channels = this.input.options.channelsFor(session.auth);
    const connection: Connection = {
      socket,
      sessionId: session.sessionId,
      isPlayer: channels.includes(playerChannel),
      subscriptions: new Set(),
      pendingSnapshots: new Set(),
    };
    connections.set(socket, connection);
    sessionConnections.set(session.sessionId, (sessionConnections.get(session.sessionId) ?? 0) + 1);
    if (connection.isPlayer) {
      this.input.playerConnections.count += 1;
      this.notify();
    }
    socket.on("close", () => {
      this.disconnect(socket);
    });
    socket.on("error", () => {
      this.disconnect(socket);
    });
    socket.on("message", (data) => {
      this.input.onMessage(socket, data.toString());
    });
    sender.sendMessage(socket, {
      type: "hello",
      protocolVersion,
      principalId: session.auth.principalId,
      channels,
    });
  }

  /** 连接关闭后的清理；重复调用保持幂等。 */
  disconnect(socket: StreamSocket): void {
    const connection = this.input.connections.get(socket);
    if (connection === undefined) {
      return;
    }
    this.input.connections.delete(socket);
    this.decrementSessionConnection(connection.sessionId);
    if (connection.isPlayer) {
      this.input.playerConnections.count = Math.max(0, this.input.playerConnections.count - 1);
      this.notify();
    }
    this.input.onDisconnected(connection);
  }

  /** 会话撤销：关闭其全部连接并丢弃计数；票据已由注册表删除。 */
  revokeSession(sessionId: string, reason: string): void {
    const { connections, sessionConnections, sender } = this.input;
    for (const [socket, connection] of [...connections]) {
      if (connection.sessionId !== sessionId) {
        continue;
      }
      connections.delete(socket);
      this.decrementSessionConnection(sessionId);
      if (connection.isPlayer) {
        this.input.playerConnections.count = Math.max(0, this.input.playerConnections.count - 1);
      }
      sender.close(socket, streamCloseCodes.sessionInvalid, reason);
    }
    this.notify();
  }

  /** 会话是否仍有活动连接；用于会话容量淘汰与重放缓冲保留判定。 */
  hasActiveConnection(sessionId: string): boolean {
    return (this.input.sessionConnections.get(sessionId) ?? 0) > 0;
  }

  /** 当前连接总数；供健康检查与容量判定复用。 */
  get size(): number {
    return this.input.connections.size;
  }

  private decrementSessionConnection(sessionId: string): void {
    const current = this.input.sessionConnections.get(sessionId) ?? 0;
    if (current <= 1) {
      this.input.sessionConnections.delete(sessionId);
      return;
    }
    this.input.sessionConnections.set(sessionId, current - 1);
  }

  private notify(): void {
    try {
      this.input.onPlayerConnectionsChanged(this.input.playerConnections.count);
    } catch {
      // 宿主回调失败不能中断连接管理；宿主自行记录错误。
    }
  }
}

/** 登录身份与会话类型的转出，供流中心继续对外暴露同一组类型。 */
export type { StreamIdentity, StreamSession, StreamChannel };
