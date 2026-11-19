/**
 * 管理 WS 会话、一次性票据、连接订阅、玩家投影增量与有界重放缓冲。
 * 依赖公共契约的消息 schema/投影类型、权限回调与注入时钟；不依赖 Fastify 或具体 socket 实现。
 * 禁止无限保留过期会话、未消费票据或断线重放缓冲，也禁止在慢连接上堆积推送。
 */
import {
  clientStreamMessageSchema,
  type AuthContext,
  type ConversationLine,
  type Json,
  type PlayerNotificationView,
  type PlayerProjection,
  type StreamChannel,
} from "@ai-npc/contracts";

/** 推送目标的最小视图；Fastify/ws 的 WebSocket 满足该结构，测试可注入假实现。 */
export interface StreamSocket {
  readonly bufferedAmount: number;
  send(payload: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
}

/** 登录身份：令牌只用于 HTTP 认证，WS 握手使用一次性票据。 */
export interface StreamIdentity {
  readonly token: string;
  readonly auth: AuthContext;
}

/** 已建立的会话；auth 在返回给 HTTP 层时按当前分支刷新。 */
export interface StreamSession {
  readonly sessionId: string;
  readonly auth: AuthContext;
  readonly token: string;
  readonly expiresAt: number;
}

/** 可观测的资源计数；不暴露票据、令牌或主体内容。 */
export interface StreamStats {
  readonly sessions: number;
  readonly tickets: number;
  readonly connections: number;
  readonly replayBuffers: number;
}

/** 当前流位置；供世界视图与客户端重连对齐。 */
export interface StreamState {
  readonly branchId: string;
  readonly streamSeq: number;
  readonly projectionVersion: number;
}

/** 流中心的注入依赖与可调边界；测试可缩短清理/保留时间并调低推送阈值。 */
export interface StreamHubOptions {
  readonly projection: () => PlayerProjection;
  /** 按会话角色计算可订阅频道；准入裁决由传输层的策略端口完成。 */
  readonly channelsFor: (auth: AuthContext) => readonly StreamChannel[];
  readonly ids: (prefix: string) => string;
  readonly tokens: (kind: "session" | "ticket") => string;
  readonly now?: () => number;
  /** 玩家连接数变化通知；宿主据此启动断线自动暂停计时。 */
  readonly onPlayerConnectionsChanged?: (connected: number) => void;
  readonly onBranchChanged?: (branchId: string) => void;
  /** 推送缓冲超过该字节数时丢弃增量并等待快照；默认 1 MiB。 */
  readonly maxBufferedBytes?: number;
  /** 后台清理间隔；默认 60 秒，不做高频轮询。 */
  readonly sweepIntervalMs?: number;
  /** 无连接会话的重放缓冲保留时间；默认 5 分钟。 */
  readonly replayRetentionMs?: number;
  readonly sessionTtlMs?: number;
  readonly ticketTtlMs?: number;
  readonly maxSessions?: number;
  readonly maxTickets?: number;
  readonly maxReplayBuffers?: number;
}

/** 一条玩家投影增量；set 只含发生变化的顶层字段。 */
interface ReplayFrame {
  readonly streamSeq: number;
  readonly projectionVersion: number;
  readonly set: Record<string, Json>;
}

/** 每个 (session, channel) 独立的有界重放缓冲，绑定分支与代次。 */
interface ReplayBuffer {
  readonly sessionId: string;
  readonly channel: StreamChannel;
  generation: number;
  branchId: string;
  readonly frames: ReplayFrame[];
  lastActiveAt: number;
}

/** 已握手连接；只有订阅集合内的频道才接收推送。 */
interface Connection {
  readonly socket: StreamSocket;
  readonly sessionId: string;
  readonly isPlayer: boolean;
  readonly subscriptions: Set<StreamChannel>;
  /** 因背压丢弃增量后置位；连接可写时补发完整快照。 */
  needsSnapshot: boolean;
}

/** 一次性 WS 票据，只记录绑定的会话与失效时间。 */
interface StreamTicket {
  readonly sessionId: string;
  readonly expiresAt: number;
}

const playerChannel: StreamChannel = "player";
const replayLimit = 200;
const defaultMaxBufferedBytes = 1024 * 1024;
const defaultSweepIntervalMs = 60_000;
const defaultReplayRetentionMs = 5 * 60_000;
const defaultSessionTtlMs = 12 * 60 * 60 * 1000;
const defaultTicketTtlMs = 30_000;
const defaultMaxSessions = 1024;
const defaultMaxTickets = 1024;
const defaultMaxReplayBuffers = 512;

/** 提醒的稳定键；派生提醒的 worldTick 会随 tick 重算，不参与同一提醒的识别。 */
function notificationKey(item: PlayerNotificationView): string {
  return `${item.kind}\u0000${item.text}`;
}

/**
 * 找出上次发布后新增的对白与提醒。
 * 对白按 dialogueId 去重；提醒按稳定键做多重集差，避免同一持续状态在每个 tick 重复推送。
 */
function appendedItems(previous: PlayerProjection, next: PlayerProjection): readonly {
  readonly kind: "dialogue" | "notification";
  readonly item: ConversationLine | PlayerNotificationView;
}[] {
  const known = new Set(previous.conversations.map((line) => line.dialogueId));
  const items: { readonly kind: "dialogue" | "notification"; readonly item: ConversationLine | PlayerNotificationView }[] = [];
  for (const line of next.conversations) {
    if (known.has(line.dialogueId)) {
      continue;
    }
    items.push({ kind: "dialogue", item: line });
  }
  const previousCounts = new Map<string, number>();
  for (const notification of previous.notifications) {
    const key = notificationKey(notification);
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  }
  const groups = new Map<string, PlayerNotificationView[]>();
  for (const notification of next.notifications) {
    const key = notificationKey(notification);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [notification]);
    } else {
      group.push(notification);
    }
  }
  for (const [key, group] of groups) {
    const added = group.length - (previousCounts.get(key) ?? 0);
    if (added <= 0) {
      continue;
    }
    for (const notification of group.slice(group.length - added)) {
      items.push({ kind: "notification", item: notification });
    }
  }
  return items;
}

/** 资源清理边界：保留最近一次发布后的顶层字段文本，用于低成本增量比较。 */
export class StreamHub {
  private readonly options: StreamHubOptions;
  private readonly now: () => number;
  private readonly maxBufferedBytes: number;
  private readonly sweepIntervalMs: number;
  private readonly replayRetentionMs: number;
  private readonly sessionTtlMs: number;
  private readonly ticketTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxTickets: number;
  private readonly maxReplayBuffers: number;
  private readonly sessions = new Map<string, StreamSession>();
  private readonly sessionById = new Map<string, StreamSession>();
  private readonly tickets = new Map<string, StreamTicket>();
  private readonly connections = new Map<StreamSocket, Connection>();
  private readonly replayBuffers = new Map<string, ReplayBuffer>();
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
  private lastProjection: PlayerProjection | null;
  /** 上一份投影各顶层字段的序列化文本；不可变且避免每次递归深比较。 */
  private lastFieldText: Map<string, string> | null;
  private closed = false;

  constructor(options: StreamHubOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.maxBufferedBytes = options.maxBufferedBytes ?? defaultMaxBufferedBytes;
    this.sweepIntervalMs = options.sweepIntervalMs ?? defaultSweepIntervalMs;
    this.replayRetentionMs = options.replayRetentionMs ?? defaultReplayRetentionMs;
    this.sessionTtlMs = options.sessionTtlMs ?? defaultSessionTtlMs;
    this.ticketTtlMs = options.ticketTtlMs ?? defaultTicketTtlMs;
    this.maxSessions = options.maxSessions ?? defaultMaxSessions;
    this.maxTickets = options.maxTickets ?? defaultMaxTickets;
    this.maxReplayBuffers = options.maxReplayBuffers ?? defaultMaxReplayBuffers;
    this.branchId = "";
    this.lastSweepAt = this.now();
    const initial = options.projection();
    this.lastProjection = Object.freeze({ ...initial });
    this.lastFieldText = this.fieldTexts(initial);
  }

  /** 设置分支；只在启动装配时调用一次，之后的切换走 applyBranchChange。 */
  setBranch(branchId: string): void {
    this.branchId = branchId;
  }

  /** 创建会话；到达上限时先撤销过期会话，再淘汰最早创建的会话。 */
  login(identity: StreamIdentity): StreamSession {
    this.ensureSweepTimer();
    this.maybeSweep();
    if (this.sessions.size >= this.maxSessions) {
      this.evictSession();
    }
    const session: StreamSession = {
      sessionId: this.options.ids("ses"),
      auth: identity.auth,
      token: this.options.tokens("session"),
      expiresAt: this.now() + this.sessionTtlMs,
    };
    this.sessions.set(session.token, session);
    this.sessionById.set(session.sessionId, session);
    return session;
  }

  /** 按令牌读取仍有效的会话；过期时立即撤销并返回 null。 */
  authenticate(token: string): StreamSession | null {
    const session = this.sessions.get(token);
    if (session === undefined) {
      return null;
    }
    if (session.expiresAt <= this.now()) {
      this.revokeSession(session.sessionId, "session expired");
      return null;
    }
    return { ...session, auth: { ...session.auth, branchId: this.branchId } };
  }

  /** 注销令牌对应的会话；缺失、重复注销都保持幂等。 */
  logout(token: string): void {
    const session = this.sessions.get(token);
    if (session !== undefined) {
      this.revokeSession(session.sessionId, "logged out");
    }
  }

  /** 签发一次性 WS 票据；未消费票据在过期后由后台清理。 */
  issueTicket(sessionId: string): { readonly ticket: string; readonly expiresAt: number } {
    this.ensureSweepTimer();
    this.maybeSweep();
    if (this.tickets.size >= this.maxTickets) {
      this.evictTicket();
    }
    const ticket = this.options.tokens("ticket");
    const expiresAt = this.now() + this.ticketTtlMs;
    this.tickets.set(ticket, { sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * 消费票据并建立连接：无论校验是否通过票据都不再可用。
   * 成功时发送 hello；失败时以 4401 关闭连接。
   */
  accept(socket: StreamSocket, ticketValue: string | undefined): void {
    const ticket = ticketValue === undefined ? undefined : this.tickets.get(ticketValue);
    if (ticketValue !== undefined) {
      this.tickets.delete(ticketValue);
    }
    if (ticket === undefined || ticket.expiresAt <= this.now()) {
      this.closeSocket(socket, 4401, "invalid ticket");
      return;
    }
    const session = this.activeSession(ticket.sessionId);
    if (session === null) {
      this.closeSocket(socket, 4401, "invalid ticket");
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
    this.sendMessage(socket, {
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
    const buffer = this.replayBuffers.get(this.bufferKey(connection.sessionId, playerChannel));
    if (buffer !== undefined) {
      buffer.lastActiveAt = this.now();
    }
  }

  /** 处理客户端帧：ping/pong、ack 补发快照与频道订阅。 */
  handleMessage(socket: StreamSocket, raw: string): void {
    const connection = this.connections.get(socket);
    if (connection === undefined) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.sendError(socket, "validation", "消息不是 JSON");
      return;
    }
    const parsed = clientStreamMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.sendError(socket, "validation", "消息格式不合法");
      return;
    }
    const value = parsed.data;
    if (value.type === "ping") {
      this.sendMessage(socket, { type: "pong" });
      return;
    }
    if (value.type === "ack") {
      // 客户端确认意味着内核缓冲大概率已排空；此时补发积压期间丢弃的快照。
      this.flushPendingSnapshot(connection);
      return;
    }
    const session = this.activeSession(connection.sessionId);
    if (session === null) {
      this.closeSocket(socket, 4401, "session expired");
      return;
    }
    if (!this.options.channelsFor(session.auth).includes(value.channel)) {
      this.sendError(socket, "forbidden", "频道不可用");
      return;
    }
    const buffer = this.ensureReplayBuffer(connection.sessionId, value.channel);
    const replay = this.selectReplay(buffer, value.fromStreamSeq);
    connection.subscriptions.add(value.channel);
    buffer.lastActiveAt = this.now();
    if (replay === null) {
      // 无可连续补发的增量时以完整快照重建基线。
      buffer.frames.length = 0;
      this.sendSnapshot(connection, value.channel);
      return;
    }
    for (const frame of replay) {
      if (!this.deliver(connection, JSON.stringify({ type: "delta", channel: value.channel, ...frame }))) {
        connection.needsSnapshot = true;
        break;
      }
    }
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
    const set = this.changedFields(projection);
    this.lastProjection = Object.freeze({ ...projection });
    this.streamSeq += 1;
    this.projectionVersion += 1;
    const frame: ReplayFrame = { streamSeq: this.streamSeq, projectionVersion: this.projectionVersion, set };
    for (const buffer of this.replayBuffers.values()) {
      if (buffer.channel !== playerChannel) {
        continue;
      }
      if (buffer.generation !== this.generation || buffer.branchId !== this.branchId) {
        this.resetReplayBuffer(buffer);
      }
      buffer.frames.push(frame);
      if (buffer.frames.length > replayLimit) {
        buffer.frames.shift();
      }
      buffer.lastActiveAt = this.now();
    }
    const deltaPayload = JSON.stringify({
      type: "delta",
      channel: playerChannel,
      streamSeq: this.streamSeq,
      projectionVersion: this.projectionVersion,
      set,
    });
    for (const connection of [...this.connections.values()]) {
      if (!connection.subscriptions.has(playerChannel)) {
        continue;
      }
      if (this.activeSession(connection.sessionId) === null) {
        continue;
      }
      if (connection.needsSnapshot) {
        this.flushPendingSnapshot(connection);
        if (connection.needsSnapshot) {
          continue;
        }
      }
      if (!this.deliver(connection, deltaPayload)) {
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
        if (!this.deliver(connection, appendPayload)) {
          connection.needsSnapshot = true;
          break;
        }
      }
    }
    return true;
  }

  /** 分支切换：递增代次与序号，清空旧分支缓冲，并向已订阅连接强制发送快照。 */
  applyBranchChange(nextBranchId: string): void {
    this.branchId = nextBranchId;
    this.generation += 1;
    this.streamSeq += 1;
    this.projectionVersion += 1;
    this.lastProjection = null;
    this.lastFieldText = null;
    for (const buffer of this.replayBuffers.values()) {
      this.resetReplayBuffer(buffer);
    }
    this.options.onBranchChanged?.(nextBranchId);
    let projection: PlayerProjection | null = null;
    try {
      projection = this.options.projection();
    } catch {
      projection = null;
    }
    for (const connection of [...this.connections.values()]) {
      if (this.activeSession(connection.sessionId) === null) {
        continue;
      }
      for (const channel of [...connection.subscriptions]) {
        if (channel !== playerChannel) {
          continue;
        }
        if (projection === null) {
          this.closeSocket(connection.socket, 1012, "projection unavailable");
          continue;
        }
        this.sendSnapshotPayload(connection, channel, projection);
      }
    }
    if (projection !== null) {
      this.lastProjection = Object.freeze({ ...projection });
      this.lastFieldText = this.fieldTexts(projection);
    }
  }

  /** 当前流位置；供世界视图与测试读取。 */
  streamState(): StreamState {
    return { branchId: this.branchId, streamSeq: this.streamSeq, projectionVersion: this.projectionVersion };
  }

  /** 资源计数；测试与健康检查用来确认后台对象有界。 */
  stats(): StreamStats {
    return {
      sessions: this.sessions.size,
      tickets: this.tickets.size,
      connections: this.connections.size,
      replayBuffers: this.replayBuffers.size,
    };
  }

  /**
   * 清理过期会话、过期未消费票据与断开连接的重放缓冲，并执行容量上限。
   * 由低频定时器与登录/推送路径按间隔触发，不做常驻高频轮询。
   */
  sweep(): void {
    const now = this.now();
    this.lastSweepAt = now;
    for (const session of [...this.sessionById.values()]) {
      if (session.expiresAt <= now) {
        this.revokeSession(session.sessionId, "session expired");
      }
    }
    for (const [ticketValue, ticket] of [...this.tickets]) {
      if (ticket.expiresAt <= now) {
        this.tickets.delete(ticketValue);
      }
    }
    for (const [key, buffer] of [...this.replayBuffers]) {
      if ((this.sessionConnections.get(buffer.sessionId) ?? 0) > 0) {
        continue;
      }
      if (now - buffer.lastActiveAt <= this.replayRetentionMs) {
        continue;
      }
      this.replayBuffers.delete(key);
    }
    // 连接恢复可写但没有新发布时，利用低频清理顺带补发积压快照。
    for (const connection of [...this.connections.values()]) {
      if (connection.needsSnapshot) {
        this.flushPendingSnapshot(connection);
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
      this.closeSocket(connection.socket, 1001, "server shutting down");
    }
    this.connections.clear();
    this.sessionConnections.clear();
    this.replayBuffers.clear();
    this.tickets.clear();
    this.sessions.clear();
    this.sessionById.clear();
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

  private bufferKey(sessionId: string, channel: StreamChannel): string {
    return `${sessionId}\u0000${channel}`;
  }

  private activeSession(sessionId: string): StreamSession | null {
    const session = this.sessionById.get(sessionId);
    if (session === undefined) {
      return null;
    }
    if (session.expiresAt <= this.now()) {
      this.revokeSession(sessionId, "session expired");
      return null;
    }
    return session;
  }

  private revokeSession(sessionId: string, reason: string): void {
    const session = this.sessionById.get(sessionId);
    if (session !== undefined) {
      this.sessionById.delete(sessionId);
      if (this.sessions.get(session.token) === session) {
        this.sessions.delete(session.token);
      }
    }
    for (const [ticketValue, ticket] of [...this.tickets]) {
      if (ticket.sessionId === sessionId) {
        this.tickets.delete(ticketValue);
      }
    }
    for (const [socket, connection] of [...this.connections]) {
      if (connection.sessionId === sessionId) {
        this.connections.delete(socket);
        this.decrementSessionConnection(sessionId);
        if (connection.isPlayer) {
          this.playerConnections = Math.max(0, this.playerConnections - 1);
        }
        this.closeSocket(socket, 4401, reason);
      }
    }
    for (const [key, buffer] of [...this.replayBuffers]) {
      if (buffer.sessionId === sessionId) {
        this.replayBuffers.delete(key);
      }
    }
    if (session !== undefined) {
      this.notifyPlayerConnections();
    }
  }

  private evictSession(): void {
    let victim: StreamSession | undefined;
    for (const session of this.sessionById.values()) {
      if (session.expiresAt <= this.now()) {
        this.revokeSession(session.sessionId, "session expired");
        return;
      }
      if (victim === undefined || session.expiresAt < victim.expiresAt) {
        victim = session;
      }
    }
    if (victim !== undefined) {
      this.revokeSession(victim.sessionId, "session capacity evicted");
    }
  }

  private evictTicket(): void {
    let victim: string | undefined;
    let victimExpiresAt = Number.POSITIVE_INFINITY;
    for (const [ticketValue, ticket] of this.tickets) {
      if (ticket.expiresAt <= this.now()) {
        this.tickets.delete(ticketValue);
        return;
      }
      if (ticket.expiresAt < victimExpiresAt) {
        victim = ticketValue;
        victimExpiresAt = ticket.expiresAt;
      }
    }
    if (victim !== undefined) {
      this.tickets.delete(victim);
    }
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

  private resetReplayBuffer(buffer: ReplayBuffer): void {
    buffer.generation = this.generation;
    buffer.branchId = this.branchId;
    buffer.frames.length = 0;
    buffer.lastActiveAt = this.now();
  }

  private ensureReplayBuffer(sessionId: string, channel: StreamChannel): ReplayBuffer {
    const key = this.bufferKey(sessionId, channel);
    const existing = this.replayBuffers.get(key);
    if (existing !== undefined) {
      if (existing.generation !== this.generation || existing.branchId !== this.branchId) {
        this.resetReplayBuffer(existing);
      }
      return existing;
    }
    if (this.replayBuffers.size >= this.maxReplayBuffers) {
      this.evictReplayBuffer();
    }
    const created: ReplayBuffer = {
      sessionId,
      channel,
      generation: this.generation,
      branchId: this.branchId,
      frames: [],
      lastActiveAt: this.now(),
    };
    this.replayBuffers.set(key, created);
    return created;
  }

  /** 优先淘汰无活动连接的最旧缓冲；全部在用则淘汰全局最旧，客户端由快照恢复。 */
  private evictReplayBuffer(): void {
    let victimKey: string | undefined;
    let victim: ReplayBuffer | undefined;
    for (const [key, buffer] of this.replayBuffers) {
      if ((this.sessionConnections.get(buffer.sessionId) ?? 0) > 0) {
        continue;
      }
      if (victim === undefined || buffer.lastActiveAt < victim.lastActiveAt) {
        victimKey = key;
        victim = buffer;
      }
    }
    if (victimKey === undefined) {
      for (const [key, buffer] of this.replayBuffers) {
        if (victim === undefined || buffer.lastActiveAt < victim.lastActiveAt) {
          victimKey = key;
          victim = buffer;
        }
      }
    }
    if (victimKey !== undefined) {
      this.replayBuffers.delete(victimKey);
    }
  }

  private selectReplay(buffer: ReplayBuffer, fromStreamSeq: number | null): readonly ReplayFrame[] | null {
    if (fromStreamSeq === null || buffer.generation !== this.generation || buffer.branchId !== this.branchId) {
      return null;
    }
    const frames = buffer.frames.filter((frame) => frame.streamSeq > fromStreamSeq);
    const first = frames.at(0);
    const last = frames.at(-1);
    if (first === undefined || last === undefined) {
      return null;
    }
    if (first.streamSeq !== fromStreamSeq + 1 || last.streamSeq !== this.streamSeq) {
      return null;
    }
    return frames;
  }

  /** 逐顶层字段比较序列化文本；引用相同则复用基线文本，避免递归深比较。 */
  private changedFields(projection: PlayerProjection): Record<string, Json> {
    const previous = this.lastProjection;
    const previousTexts = this.lastFieldText;
    const texts = new Map<string, string>();
    const changed: Record<string, Json> = {};
    const values = projection as unknown as Record<string, Json>;
    for (const [key, value] of Object.entries(values)) {
      const previousText = previousTexts?.get(key);
      if (previous !== null && previousText !== undefined) {
        const previousValue = (previous as unknown as Record<string, Json>)[key];
        if (Object.is(previousValue, value)) {
          texts.set(key, previousText);
          continue;
        }
      }
      const text = JSON.stringify(value);
      texts.set(key, text);
      if (previousText !== text) {
        changed[key] = value;
      }
    }
    this.lastFieldText = texts;
    return changed;
  }

  private fieldTexts(projection: PlayerProjection): Map<string, string> {
    const texts = new Map<string, string>();
    for (const [key, value] of Object.entries(projection)) {
      texts.set(key, JSON.stringify(value));
    }
    return texts;
  }

  /** 发送完整快照；缓冲已超阈值时保留补发标记，等连接可写后再发。 */
  private sendSnapshot(connection: Connection, channel: StreamChannel): void {
    if (channel !== playerChannel) {
      // 控制台频道没有投影快照，订阅后等待增量事件。
      return;
    }
    let projection: PlayerProjection;
    try {
      projection = this.options.projection();
    } catch {
      this.closeSocket(connection.socket, 1012, "projection unavailable");
      return;
    }
    this.sendSnapshotPayload(connection, channel, projection);
  }

  private sendSnapshotPayload(connection: Connection, channel: StreamChannel, projection: PlayerProjection): void {
    const payload = JSON.stringify({
      type: "snapshot",
      channel,
      streamSeq: this.streamSeq,
      projectionVersion: this.projectionVersion,
      data: projection,
    });
    if (!this.deliver(connection, payload)) {
      connection.needsSnapshot = true;
      return;
    }
    connection.needsSnapshot = false;
  }

  /** 连接可写且需要快照时补发一次；快照覆盖积压的所有增量。 */
  private flushPendingSnapshot(connection: Connection): void {
    if (!connection.needsSnapshot || !connection.subscriptions.has(playerChannel)) {
      return;
    }
    this.sendSnapshot(connection, playerChannel);
  }

  /** 推送前检查缓冲；超阈值不排队、不阻塞其他连接，由调用方标记需要快照。 */
  private deliver(connection: Connection, payload: string): boolean {
    if (connection.socket.bufferedAmount > this.maxBufferedBytes) {
      return false;
    }
    try {
      connection.socket.send(payload);
      return true;
    } catch {
      this.closeSocket(connection.socket, 1012, "stream unavailable");
      return false;
    }
  }

  private sendMessage(socket: StreamSocket, message: Record<string, unknown>): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.closeSocket(socket, 1012, "stream unavailable");
    }
  }

  private sendError(socket: StreamSocket, code: "validation" | "forbidden", safeMessage: string): void {
    this.sendMessage(socket, { type: "error", code, safeMessage });
  }

  private closeSocket(socket: StreamSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      try {
        socket.terminate();
      } catch {
        // 连接已不可用；没有额外清理动作。
      }
    }
  }
}
