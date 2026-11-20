/**
 * 管理 WS 连接、订阅、玩家投影增量发布与有界重放；会话/票据、帧处理、重放缓冲与发送出口由独立模块负责。
 * 依赖公共契约的投影类型、权限回调、注入时钟、会话注册表、重放缓冲与发送器。
 * 禁止无限保留过期会话、未消费票据或断线重放缓冲，也禁止在慢连接上堆积推送。
 */
import type { PlayerProjection } from "@ai-npc/contracts";
import { handleClientMessage } from "./client-messages";
import { ReplayStore } from "./replay-store";
import { SessionRegistry } from "./session-registry";
import { SocketSender } from "./stream-delivery";
import {
  appendedItems,
  changedFields,
  fieldTexts,
  hubLimits,
  playerChannel,
  type Connection,
  type StreamHubOptions,
  type StreamIdentity,
  type StreamSession,
  type StreamSocket,
  type StreamStats,
  type StreamState,
} from "./stream-types";

export type {
  StreamHubOptions,
  StreamIdentity,
  StreamSession,
  StreamSocket,
  StreamState,
  StreamStats,
} from "./stream-types";

/** 管理 WS 会话、一次性票据、连接订阅、玩家投影增量与有界重放缓冲。 */
export class StreamHub {
  private readonly options: StreamHubOptions;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly sessions: SessionRegistry;
  private readonly replay: ReplayStore;
  private readonly sender: SocketSender;
  private readonly connections = new Map<StreamSocket, Connection>();
  /** 每个会话的活动连接数；用于判断重放缓冲是否仍绑定在线连接。 */
  private readonly sessionConnections = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastSweepAt: number;
  private playerConnections = 0;
  private branchId: string;
  private generation = 0;
  private streamSeq = 0;
  private projectionVersion = 0;
  /** 上一份投影的顶层只读副本；用于识别新增对白与提醒。 */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  private lastProjection: PlayerProjection | null;
  /** 上一份投影各顶层字段的序列化文本；不可变且避免每次递归深比较。 */
  private lastFieldText: Map<string, string> | null;
  private closed = false;

  constructor(options: StreamHubOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const limits = hubLimits(options);
    this.sweepIntervalMs = limits.sweepIntervalMs;
    this.branchId = "";
    this.lastSweepAt = this.now();
    this.sessions = new SessionRegistry({
      ids: options.ids,
      tokens: options.tokens,
      now: this.now,
      sessionTtlMs: limits.sessionTtlMs,
      ticketTtlMs: limits.ticketTtlMs,
      maxSessions: limits.maxSessions,
      maxTickets: limits.maxTickets,
      currentBranchId: () => this.branchId,
      onSessionRevoked: (sessionId, reason) => {
        this.revokeSessionConnections(sessionId, reason);
      },
    });
    this.replay = new ReplayStore({
      now: this.now,
      maxReplayBuffers: limits.maxReplayBuffers,
      retentionMs: limits.replayRetentionMs,
      hasActiveConnection: (sessionId) => (this.sessionConnections.get(sessionId) ?? 0) > 0,
    });
    this.sender = new SocketSender({
      projection: options.projection,
      sequence: () => ({ streamSeq: this.streamSeq, projectionVersion: this.projectionVersion }),
      maxBufferedBytes: limits.maxBufferedBytes,
    });
    const initial = options.projection();
    this.lastProjection = Object.freeze({ ...initial });
    this.lastFieldText = fieldTexts(initial);
  }

  /** 设置分支；只在启动装配时调用一次，之后的切换走 applyBranchChange。 */
  setBranch(branchId: string): void {
    this.branchId = branchId;
    this.replay.resetAll(branchId, this.generation);
  }

  /** 创建会话；到达上限时先撤销过期会话，再淘汰最早创建的会话。 */
  login(identity: StreamIdentity): StreamSession {
    this.ensureSweepTimer();
    this.maybeSweep();
    return this.sessions.login(identity);
  }

  /** 按令牌读取仍有效的会话；过期时立即撤销并返回 null。 */
  authenticate(token: string): StreamSession | null {
    return this.sessions.authenticate(token);
  }

  /** 注销令牌对应的会话；缺失、重复注销都保持幂等。 */
  logout(token: string): void {
    this.sessions.logout(token);
  }

  /** 签发一次性 WS 票据；未消费票据在过期后由后台清理。 */
  issueTicket(sessionId: string): { readonly ticket: string; readonly expiresAt: number } {
    this.ensureSweepTimer();
    this.maybeSweep();
    return this.sessions.issueTicket(sessionId);
  }

  /**
   * 消费票据并建立连接：无论校验是否通过票据都不再可用。
   * 成功时发送 hello；失败时以 4401 关闭连接。
   */
  accept(socket: StreamSocket, ticketValue: string | undefined): void {
    const ticket = this.sessions.takeTicket(ticketValue);
    if (ticket === undefined || ticket.expiresAt <= this.now()) {
      this.sender.close(socket, 4401, "invalid ticket");
      return;
    }
    const session = this.sessions.activeSession(ticket.sessionId);
    if (session === null) {
      this.sender.close(socket, 4401, "invalid ticket");
      return;
    }
    const channels = this.options.channelsFor(session.auth);
    const connection: Connection = {
      socket,
      sessionId: session.sessionId,
      isPlayer: channels.includes(playerChannel),
      subscriptions: new Set(),
      needsSnapshot: false,
    };
    this.connections.set(socket, connection);
    this.sessionConnections.set(session.sessionId, (this.sessionConnections.get(session.sessionId) ?? 0) + 1);
    if (connection.isPlayer) {
      this.playerConnections += 1;
      this.notifyPlayerConnections();
    }
    socket.on("close", () => {
      this.disconnect(socket);
    });
    socket.on("error", () => {
      this.disconnect(socket);
    });
    socket.on("message", (data) => {
      this.handleMessage(socket, data.toString());
    });
    this.sender.sendMessage(socket, {
      type: "hello",
      protocolVersion: "1",
      principalId: session.auth.principalId,
      channels,
    });
  }

  /** 连接关闭后的清理；重复调用保持幂等。 */
  disconnect(socket: StreamSocket): void {
    const connection = this.connections.get(socket);
    if (connection === undefined) {
      return;
    }
    this.connections.delete(socket);
    this.decrementSessionConnection(connection.sessionId);
    if (connection.isPlayer) {
      this.playerConnections = Math.max(0, this.playerConnections - 1);
      this.notifyPlayerConnections();
    }
    this.replay.touch(connection.sessionId, playerChannel);
  }

  /** 处理客户端帧：交给独立的帧处理模块，连接与竞态由流中心持有。 */
  handleMessage(socket: StreamSocket, raw: string): void {
    handleClientMessage(
      {
        connections: this.connections,
        sessions: this.sessions,
        replay: this.replay,
        sender: this.sender,
        channelsFor: this.options.channelsFor,
        streamSeq: () => this.streamSeq,
      },
      socket,
      raw,
    );
  }

  /**
   * 发布一次玩家投影：计算顶层字段增量，记录有界重放缓冲并按连接推送。
   * 只有增量真正变化时 set 才非空；空 set 仍推进版本，供客户端识别心跳。
   */
  publish(): boolean {
    if (this.closed) {
      return false;
    }
    this.ensureSweepTimer();
    this.maybeSweep();
    let projection: PlayerProjection;
    try {
      projection = this.options.projection();
    } catch (error) {
      if (error instanceof Error && error.message.includes("尚未初始化")) {
        return false;
      }
      throw error;
    }
    const appends = this.lastProjection === null ? [] : appendedItems(this.lastProjection, projection);
    const changed = changedFields(this.lastProjection, this.lastFieldText, projection);
    this.lastProjection = Object.freeze({ ...projection });
    this.lastFieldText = changed.texts;
    this.streamSeq += 1;
    this.projectionVersion += 1;
    this.replay.append({ streamSeq: this.streamSeq, projectionVersion: this.projectionVersion, set: changed.set });
    const deltaPayload = JSON.stringify({
      type: "delta",
      channel: playerChannel,
      streamSeq: this.streamSeq,
      projectionVersion: this.projectionVersion,
      set: changed.set,
    });
    for (const connection of [...this.connections.values()]) {
      if (!connection.subscriptions.has(playerChannel)) {
        continue;
      }
      if (this.sessions.activeSession(connection.sessionId) === null) {
        continue;
      }
      if (connection.needsSnapshot) {
        this.sender.flushPendingSnapshot(connection);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flushPendingSnapshot 会清除 needsSnapshot，TypeScript 的属性收窄不感知跨方法修改。
        if (connection.needsSnapshot) {
          continue;
        }
      }
      if (!this.sender.deliver(connection, deltaPayload)) {
        connection.needsSnapshot = true;
        continue;
      }
      // 同一 streamSeq 的新对白/提醒按单条追加；慢连接在任一次投递失败后等快照恢复。
      for (const append of appends) {
        const appendPayload = JSON.stringify({
          type: "append",
          channel: playerChannel,
          streamSeq: this.streamSeq,
          kind: append.kind,
          item: append.item,
        });
        if (!this.sender.deliver(connection, appendPayload)) {
          connection.needsSnapshot = true;
          break;
        }
      }
    }
    return true;
  }

  /**
   * 发布投影；失败时安全上报并让玩家连接改发完整快照。
   * 失败的发布没有推进 streamSeq，继续补发旧增量会让客户端停在旧视图；
   * 清空重放缓冲并重建基线，订阅中的连接立即补发快照，其余在下次订阅或 ack 时重建。
   */
  // eslint-disable-next-line no-unused-vars -- 上报回调的类型参数名用于表达调用契约，运行时由调用方传入。
  publishWithResync(report: (message: string, error: unknown) => void): void {
    const reportSafely = (message: string, error: unknown): void => {
      try {
        report(message, error);
      } catch {
        // 上报失败不能反过来影响已提交操作或连接清理。
      }
    };
    try {
      this.publish();
    } catch (error) {
      reportSafely("projection publish failed", error);
      try {
        this.resyncPlayers(reportSafely);
      } catch (error) {
        reportSafely("projection resync failed", error);
      }
    }
  }

  /** 投影基线失效后的恢复：清空旧增量，按当前投影重建基线并向订阅中的玩家补发完整快照。 */
  // eslint-disable-next-line no-unused-vars -- 上报回调的类型参数名用于表达调用契约，运行时由调用方传入。
  private resyncPlayers(report: (message: string, error: unknown) => void): void {
    this.replay.resetAll(this.branchId, this.generation);
    const players = [...this.connections.values()].filter((connection) => connection.isPlayer);
    for (const connection of players) {
      connection.needsSnapshot = true;
    }
    let projection: PlayerProjection;
    try {
      projection = this.options.projection();
    } catch (error) {
      report("projection resync failed", error);
      return;
    }
    let payload: string;
    try {
      payload = JSON.stringify({
        type: "snapshot",
        channel: playerChannel,
        streamSeq: this.streamSeq,
        projectionVersion: this.projectionVersion,
        data: projection,
      });
    } catch (error) {
      report("projection resync failed", error);
      return;
    }
    // 快照已经包含当前状态；先推进增量基线，避免下一次 publish 重复追加快照里已有的条目。
    try {
      this.lastProjection = Object.freeze({ ...projection });
      this.lastFieldText = fieldTexts(projection);
    } catch (error) {
      report("projection resync failed", error);
      return;
    }
    for (const connection of players) {
      // 过期会话可能在读取投影期间失效；activeSession 会撤销会话并关闭其连接，不能再补发快照。
      if (this.sessions.activeSession(connection.sessionId) === null) {
        continue;
      }
      if (!connection.subscriptions.has(playerChannel)) {
        continue;
      }
      this.sender.sendSerializedSnapshot(connection, payload);
    }
  }

  /** 分支切换：递增代次与序号，清空旧分支缓冲，并向已订阅连接强制发送快照。 */
  applyBranchChange(nextBranchId: string): void {
    this.branchId = nextBranchId;
    this.generation += 1;
    this.streamSeq += 1;
    this.projectionVersion += 1;
    this.lastProjection = null;
    this.lastFieldText = null;
    this.replay.resetAll(nextBranchId, this.generation);
    this.options.onBranchChanged?.(nextBranchId);
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
    let projection: PlayerProjection | null = null;
    try {
      projection = this.options.projection();
    } catch {
      projection = null;
    }
    for (const connection of [...this.connections.values()]) {
      if (this.sessions.activeSession(connection.sessionId) === null) {
        continue;
      }
      for (const channel of [...connection.subscriptions]) {
        if (channel !== playerChannel) {
          continue;
        }
        if (projection === null) {
          this.sender.close(connection.socket, 1012, "projection unavailable");
          continue;
        }
        this.sender.sendSnapshotPayload(connection, channel, projection);
      }
    }
    if (projection !== null) {
      this.lastProjection = Object.freeze({ ...projection });
      this.lastFieldText = fieldTexts(projection);
    }
  }

  /** 当前流位置；供世界视图与测试读取。 */
  streamState(): StreamState {
    return { branchId: this.branchId, streamSeq: this.streamSeq, projectionVersion: this.projectionVersion };
  }

  /** 资源计数；测试与健康检查用来确认后台对象有界。 */
  stats(): StreamStats {
    return {
      sessions: this.sessions.sessionCount(),
      tickets: this.sessions.ticketCount(),
      connections: this.connections.size,
      replayBuffers: this.replay.count(),
    };
  }

  /**
   * 清理过期会话、过期未消费票据与断开连接的重放缓冲，并执行容量上限。
   * 由低频定时器与登录/推送路径按间隔触发，不做常驻高频轮询。
   */
  sweep(): void {
    const now = this.now();
    this.lastSweepAt = now;
    this.sessions.sweep(now);
    this.replay.sweep(now);
    // 连接恢复可写但没有新发布时，利用低频清理顺带补发积压快照。
    for (const connection of [...this.connections.values()]) {
      if (connection.needsSnapshot) {
        this.sender.flushPendingSnapshot(connection);
      }
    }
  }

  /** 清空后台对象并关闭连接；close 后 publish 不再工作。 */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const connection of [...this.connections.values()]) {
      this.sender.close(connection.socket, 1001, "server shutting down");
    }
    this.connections.clear();
    this.sessionConnections.clear();
    this.replay.clear();
    this.sessions.clear();
    this.playerConnections = 0;
  }

  /** 首次使用流资源时才建立低频清理定时器；unref 避免阻止进程退出。 */
  private ensureSweepTimer(): void {
    if (this.sweepTimer !== null || this.closed) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private maybeSweep(): void {
    if (this.now() - this.lastSweepAt >= this.sweepIntervalMs) {
      this.sweep();
    }
  }

  /** 会话撤销：关闭其全部连接并丢弃缓冲；票据已由注册表删除。 */
  private revokeSessionConnections(sessionId: string, reason: string): void {
    for (const [socket, connection] of [...this.connections]) {
      if (connection.sessionId !== sessionId) {
        continue;
      }
      this.connections.delete(socket);
      this.decrementSessionConnection(sessionId);
      if (connection.isPlayer) {
        this.playerConnections = Math.max(0, this.playerConnections - 1);
      }
      this.sender.close(socket, 4401, reason);
    }
    this.replay.releaseSession(sessionId);
    this.notifyPlayerConnections();
  }

  private decrementSessionConnection(sessionId: string): void {
    const current = this.sessionConnections.get(sessionId) ?? 0;
    if (current <= 1) {
      this.sessionConnections.delete(sessionId);
      return;
    }
    this.sessionConnections.set(sessionId, current - 1);
  }

  private notifyPlayerConnections(): void {
    try {
      this.options.onPlayerConnectionsChanged?.(this.playerConnections);
    } catch {
      // 宿主回调失败不能中断连接管理；宿主自行记录错误。
    }
  }
}
