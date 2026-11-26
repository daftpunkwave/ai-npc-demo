/**
 * 管理 WS 连接、订阅、玩家投影增量发布与有界重放；会话/票据、帧处理、重放缓冲与发送出口由独立模块负责。
 * 依赖公共契约的投影类型、权限回调、注入时钟、会话注册表、重放缓冲与发送器。
 * 禁止无限保留过期会话、未消费票据或断线重放缓冲，也禁止在慢连接上堆积推送。
 */
import {
  protocolVersion,
  streamCloseCodes,
  type Json,
  type PlayerProjection,
  type StreamChannel,
} from "@ai-npc/contracts";
import { handleClientMessage } from "./client-messages";
import { ReplayStore } from "./replay-store";
import { SessionRegistry } from "./session-registry";
import { ConnectionAdmission } from "./stream-connections";
import { SocketSender } from "./stream-delivery";
import {
  publishProjection,
  resyncProjection,
  type ProjectionBaseline,
  type ProjectionPublisherInput,
} from "./stream-publish";
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
  /** 每个会话的活动连接数；用于判断重放缓冲是否仍绑定在线连接，并限制单会话连接数。 */
  private readonly sessionConnections = new Map<string, number>();
  /** 玩家连接计数由本类与接纳模块共享同一可变单元，避免两处计数漂移。 */
  private readonly playerConnections = { count: 0 };
  private readonly admission: ConnectionAdmission;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastSweepAt: number;
  private branchId: string;
  private generation = 0;
  /** 流游标：发布模块直接推进其中的序号与版本。 */
  private readonly cursor = { streamSeq: 0, projectionVersion: 0 };
  private readonly consoleSequences = new Map<StreamChannel, number>();
  /** 增量基线：上一份投影与其各顶层字段文本，由发布模块维护。 */
  private readonly baseline: ProjectionBaseline = { projection: null, fieldText: null };
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
      // 容量淘汰优先选择没有活动连接的会话；活跃连接由本类计数，不交给注册表猜测。
      hasActiveConnection: (sessionId) => (this.sessionConnections.get(sessionId) ?? 0) > 0,
    });
    this.replay = new ReplayStore({
      now: this.now,
      maxReplayBuffers: limits.maxReplayBuffers,
      retentionMs: limits.replayRetentionMs,
      hasActiveConnection: (sessionId) => (this.sessionConnections.get(sessionId) ?? 0) > 0,
    });
    this.sender = new SocketSender({
      projection: options.projection,
      // 分支身份每次现取：恢复或重开会切换在线分支，快照必须携带当时的身份。
      snapshotIdentity: () => ({ worldId: options.worldId, branchId: this.branchId }),
      sequence: () => ({ streamSeq: this.cursor.streamSeq, projectionVersion: this.cursor.projectionVersion }),
      ...(options.channelSnapshot === undefined
        ? {}
        : { channelSnapshot: options.channelSnapshot }),
      channelSequence: (channel) => this.consoleSequences.get(channel) ?? 0,
      maxBufferedBytes: limits.maxBufferedBytes,
    });
    const initial = options.projection();
    this.baseline.projection = Object.freeze({ ...initial });
    this.baseline.fieldText = fieldTexts(initial);
    this.admission = new ConnectionAdmission({
      options,
      now: this.now,
      sessions: this.sessions,
      sender: this.sender,
      branchId: () => this.branchId,
      connections: this.connections,
      sessionConnections: this.sessionConnections,
      playerConnections: this.playerConnections,
      onPlayerConnectionsChanged: (connected) => {
        this.notifyPlayerConnections(connected);
      },
      onMessage: (socket, raw) => {
        this.handleMessage(socket, raw);
      },
      onDisconnected: (connection) => {
        this.replay.touch(connection.sessionId, playerChannel);
      },
    });
  }

  /** 设置分支；只在启动装配时调用一次，之后的切换走 applyBranchChange。 */
  setBranch(branchId: string): void {
    this.branchId = branchId;
    this.replay.resetAll(branchId, this.generation);
  }

  /** 创建会话；容量不足时先清理过期会话，再淘汰无活动连接的会话，全部活跃时拒绝新会话。 */
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
   * 消费票据并建立连接：票据校验、容量上限、连接计数与关闭清理由接纳模块负责。
   * 票据不可用与会话失效使用不同关闭码，见接纳模块的说明。
   */
  accept(socket: StreamSocket, ticketValue: string | undefined): void {
    this.admission.accept(socket, ticketValue);
  }

  /** 连接关闭后的清理；重复调用保持幂等。 */
  disconnect(socket: StreamSocket): void {
    this.admission.disconnect(socket);
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
        channelProvided: (channel) => this.channelProvided(channel),
        streamSeq: () => this.cursor.streamSeq,
      },
      socket,
      raw,
    );
  }

  /**
   * 该频道当前是否有能收到推送的订阅者。
   * 供宿主在构造控制台快照前短路：没人订阅时构建与序列化整份快照是纯浪费，
   * 而且检查必须发生在构造之前，publishConsole 内部的订阅判断已经在数据算完之后。
   * 会话已失效的连接不计入：发布路径本就跳过它们，把它们算作订阅者只会让快照
   * 持续被构造，而结果没有任何投递对象。
   */
  hasSubscriber(channel: StreamChannel): boolean {
    for (const connection of this.connections.values()) {
      if (!connection.subscriptions.has(channel)) {
        continue;
      }
      if (this.sessions.activeSession(connection.sessionId) === null) {
        continue;
      }
      return true;
    }
    return false;
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
    // 投影读取失败直接向上抛出：全库没有可静默跳过的“未初始化”错误文本，吞错会掩盖真实故障。
    publishProjection(this.publisher());
    return true;
  }

  /** 向指定控制台频道发布完整快照；每个频道使用独立序号。 */
  publishConsole(channel: StreamChannel, data: Json): void {
    if (this.closed || channel === playerChannel) {
      return;
    }
    const streamSeq = (this.consoleSequences.get(channel) ?? 0) + 1;
    this.consoleSequences.set(channel, streamSeq);
    for (const connection of [...this.connections.values()]) {
      if (!connection.subscriptions.has(channel)) {
        continue;
      }
      if (this.sessions.activeSession(connection.sessionId) === null) {
        continue;
      }
      this.sender.sendChannelSnapshot(connection, channel, data, streamSeq);
    }
  }

  /**
   * 频道是否存在实际生产者。
   * 玩家投影由本类直接生成；控制台频道由装配方注入判定，未注入时不擅自拒绝订阅，
   * 保持流中心作为底层设施的既有契约。生产装配（createServerApp）始终显式注入，
   * 因此已授权但尚无实现的频道在生产路径上一定拿到 not-ready。
   */
  private channelProvided(channel: StreamChannel): boolean {
    if (channel === playerChannel) {
      return true;
    }
    return this.options.channelProvided?.(channel) ?? true;
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
  private resyncPlayers(report: (message: string, error: unknown) => void): void {
    resyncProjection(this.publisher(), report);
  }

  /** 组装一次投影发布所需的连接、会话、重放缓冲、发送器与当前基线。 */
  private publisher(): ProjectionPublisherInput {
    return {
      connections: this.connections,
      sessions: this.sessions,
      replay: this.replay,
      sender: this.sender,
      projection: this.options.projection,
      worldId: this.options.worldId,
      branchId: () => this.branchId,
      generation: () => this.generation,
      cursor: this.cursor,
      baseline: this.baseline,
      playerChannel,
    };
  }

  /** 分支切换：递增代次与序号，清空旧分支缓冲，并向已订阅连接强制发送快照。 */
  applyBranchChange(nextBranchId: string): void {
    this.branchId = nextBranchId;
    this.generation += 1;
    this.cursor.streamSeq += 1;
    this.cursor.projectionVersion += 1;
    this.baseline.projection = null;
    this.baseline.fieldText = null;
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
        if (channel === playerChannel) {
          if (projection === null) {
            this.sender.close(connection.socket, 1012, "projection unavailable");
            continue;
          }
          this.sender.sendSnapshotPayload(connection, channel, projection);
          continue;
        }
        // 分支切换后非玩家频道的快照同样失效：它们的内容按分支查询，
        // 旧快照描述的是已归档分支。交给 sendSnapshot 统一取快照来源，
        // 该频道未实现或未接线时它自行跳过，取快照抛错时按频道不可用关闭连接。
        this.sender.sendSnapshot(connection, channel);
      }
    }
    if (projection !== null) {
      this.baseline.projection = Object.freeze({ ...projection });
      this.baseline.fieldText = fieldTexts(projection);
    }
  }

  /** 当前流位置；供世界视图与测试读取。 */
  streamState(): StreamState {
    return { branchId: this.branchId, streamSeq: this.cursor.streamSeq, projectionVersion: this.cursor.projectionVersion };
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
      if (connection.pendingSnapshots.size > 0) {
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
    this.playerConnections.count = 0;
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
    this.admission.revokeSession(sessionId, reason);
    this.replay.releaseSession(sessionId);
  }

  private notifyPlayerConnections(connected: number): void {
    try {
      this.options.onPlayerConnectionsChanged?.(connected);
    } catch {
      // 宿主回调失败不能中断连接管理；宿主自行记录错误。
    }
  }
}
