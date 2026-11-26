/**
 * 管理 WS 连接、订阅、玩家投影增量发布、有界重放与心跳活性；会话/票据、帧处理、重放缓冲与发送出口由独立模块负责。
 * 依赖公共契约的投影类型、权限回调、注入时钟、会话注册表、重放缓冲与发送器。
 * 禁止无限保留过期会话、未消费票据或断线重放缓冲，也禁止在慢连接上堆积推送；禁止让半开连接继续占用计数。
 */
import {
  protocolVersion,
  streamCloseCodes,
  type Json,
  type PlayerProjection,
  type StreamChannel,
} from "@ai-npc/contracts";
import { handleClientMessage } from "./client-messages";
import { HeartbeatProbe } from "./heartbeat-probe";
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
  /** 每个会话的活动连接数；用于判断重放缓冲是否仍绑定在线连接，并限制单会话连接数。 */
  private readonly sessionConnections = new Map<string, number>();
  /** 全局连接上限与单会话连接上限；与其它 hubLimits 同源，不在此另设默认。 */
  private readonly maxConnections: number;
  private readonly maxConnectionsPerSession: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSweepAt: number;
  private playerConnections = 0;
  private branchId: string;
  private generation = 0;
  private streamSeq = 0;
  private projectionVersion = 0;
  private readonly consoleSequences = new Map<StreamChannel, number>();
  /** 心跳间隔；半开连接没有 close 事件，只能靠定时探测回收。 */
  private readonly heartbeatIntervalMs: number;
  /** 连接活性探测器：超时回收与 ping 推送都在其中，本类只提供依赖。 */
  private readonly probe: HeartbeatProbe;
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
    this.maxConnections = limits.maxConnections;
    this.maxConnectionsPerSession = limits.maxConnectionsPerSession;
    this.heartbeatIntervalMs = limits.heartbeatIntervalMs;
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
      sequence: () => ({ streamSeq: this.streamSeq, projectionVersion: this.projectionVersion }),
      ...(options.channelSnapshot === undefined
        ? {}
        : { channelSnapshot: options.channelSnapshot }),
      channelSequence: (channel) => this.consoleSequences.get(channel) ?? 0,
      maxBufferedBytes: limits.maxBufferedBytes,
    });
    // 探测器只拿连接集合与两个出口；超时回收走本类的 disconnect，确保计数同步递减。
    this.probe = new HeartbeatProbe({
      connections: () => this.connections,
      disconnect: (socket) => {
        this.disconnect(socket);
      },
      ping: (socket) => {
        this.sender.sendMessage(socket, { type: "ping" });
      },
      now: this.now,
      timeoutMs: limits.heartbeatTimeoutMs,
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
   * 消费票据并建立连接：无论校验是否通过票据都不再可用。
   * 成功时发送 hello；只有票据本身不可用（缺失、过期、已消费、被容量淘汰）才用 4408，
   * 票据有效但其绑定的会话已失效时仍用 4401。
   * 两者不能共用一个关闭码：票据过期是重新申请票据就能恢复的握手失败，
   * 若复用会话关闭码，客户端会清除仍然有效的会话令牌并停止重连。
   */
  accept(socket: StreamSocket, ticketValue: string | undefined): void {
    const ticket = this.sessions.takeTicket(ticketValue);
    if (ticket === undefined || ticket.expiresAt <= this.now()) {
      this.sender.close(socket, streamCloseCodes.ticketInvalid, "invalid ticket");
      return;
    }
    const session = this.sessions.activeSession(ticket.sessionId);
    if (session === null) {
      this.sender.close(socket, streamCloseCodes.sessionInvalid, "session expired");
      return;
    }
    // 容量检查必须在注册监听与计入计数之前：超限连接既不能占 Map 记录，
    // 也不能让 sessionConnections 与 playerConnections 留下无对应连接的计数。
    // 拒绝时用 reject 而非 close：连接不在注册表内，若只发关闭帧等对端回应，
    // 半开状态下没有任何清理路径会回收它。
    if (this.connections.size >= this.maxConnections) {
      this.sender.reject(socket, 1013, "too many connections");
      return;
    }
    if ((this.sessionConnections.get(session.sessionId) ?? 0) >= this.maxConnectionsPerSession) {
      this.sender.reject(socket, 1013, "too many session connections");
      return;
    }
    const channels = this.options.channelsFor(session.auth);
    const connection: Connection = {
      socket,
      sessionId: session.sessionId,
      isPlayer: channels.includes(playerChannel),
      subscriptions: new Set(),
      pendingSnapshots: new Set(),
      lastSeenAt: this.now(),
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
      // 任何合法帧都先记账再解析：半开判定看的是「对端还在不在」，
      // 而不是「这一帧是否被业务接受」，否则非法帧会被误当成失联证据。
      connection.lastSeenAt = this.now();
      this.handleMessage(socket, data.toString());
    });
    this.sender.sendMessage(socket, {
      type: "hello",
      protocolVersion,
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
        channelProvided: (channel) => this.channelProvided(channel),
        streamSeq: () => this.streamSeq,
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
    const projection = this.options.projection();
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
      if (connection.pendingSnapshots.has(playerChannel)) {
        this.sender.flushPendingSnapshot(connection);
        if (connection.pendingSnapshots.has(playerChannel)) {
          continue;
        }
      }
      if (!this.sender.deliver(connection, deltaPayload)) {
        connection.pendingSnapshots.add(playerChannel);
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
          connection.pendingSnapshots.add(playerChannel);
          break;
        }
      }
    }
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
  // eslint-disable-next-line no-unused-vars -- 上报回调的类型参数名用于表达调用契约，运行时由调用方传入。
  private resyncPlayers(report: (message: string, error: unknown) => void): void {
    this.replay.resetAll(this.branchId, this.generation);
    // 只有真正订阅了玩家频道的连接才需要补发：仅具备玩家身份但未订阅的连接
    // 不该因为一次重同步而在后续 sweep 或 ack 时收到完整投影。
    const players = [...this.connections.values()].filter((connection) =>
      connection.isPlayer && connection.subscriptions.has(playerChannel));
    for (const connection of players) {
      connection.pendingSnapshots.add(playerChannel);
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
        // 一份投影复用到多个连接，但身份仍按当前在线分支现取。
        worldId: this.options.worldId,
        branchId: this.branchId,
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
      this.sender.sendSerializedSnapshot(connection, playerChannel, payload);
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
      if (connection.pendingSnapshots.size > 0) {
        this.sender.flushPendingSnapshot(connection);
      }
    }
  }

  /**
   * 心跳：超过超时窗口没有收到任何帧的连接视为半开，直接终止，随后向存活连接发 ping。
   *
   * 回收与推送的细节在 HeartbeatProbe 内，这里只提供连接集合、回收清理与发送出口。
   * 必须走 `disconnect` 而不是只关 socket：`playerConnections` 计数是宿主判断
   * 「玩家全部断开」的唯一输入，不递减就永远不会触发断线自动暂停，
   * 时钟会在无人在线时继续推进，违背「断线经宽限自动暂停、离线时间不补算」的约定。
   */
  heartbeat(): void {
    if (this.closed) {
      return;
    }
    this.probe.probe();
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
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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

  /**
   * 首次使用流资源时才建立后台定时器；unref 避免阻止进程退出。
   * 心跳与清理分开计时：心跳间隔短于清理间隔，绑在一起会让探测频率被清理节拍绑死。
   */
  private ensureSweepTimer(): void {
    if (this.closed) {
      return;
    }
    if (this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => {
        this.sweep();
      }, this.sweepIntervalMs);
      this.sweepTimer.unref();
    }
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => {
        this.heartbeat();
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref();
    }
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
      this.sender.close(socket, streamCloseCodes.sessionInvalid, reason);
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
