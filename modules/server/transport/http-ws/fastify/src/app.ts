/**
 * 创建 Fastify HTTP/WS 应用：登录、会话、装配握手、玩家读接口、命令与回执、时钟控制、存档与玩家流。
 * 依赖 authority、存储、投影/会话/开局/时钟/存档回调与身份令牌；不直接写规则聚合或查存储表。
 * 禁止信任页面自报角色、绕过 Origin 校验或把内部错误细节返回给客户端。
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket, { type WebSocket } from "@fastify/websocket";
import cors from "@fastify/cors";
import {
  campaignResponseSchema,
  clientStreamMessageSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  conversationQuerySchema,
  conversationResponseSchema,
  errorResponseSchema,
  healthResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  sessionAssemblyQuerySchema,
  sessionAssemblyResponseSchema,
  type AuthContext,
  type ClockView,
  type CommandEnvelope,
  type CommandReceipt,
  type ConversationLine,
  type ConversationQuery,
  type ConversationResponse,
  type ErrorCode,
  type PlayerNotificationView,
  type PlayerProjection,
  type ResolvedModuleSet,
  type SessionDescriptor,
  type StartOption,
  type StoragePort,
  type StreamChannel,
} from "@ai-npc/contracts";

/** 传输层需要的命令网关视图；不依赖 authority 实现包。 */
function executeCommandHook(auth: AuthContext, envelope: CommandEnvelope): CommandReceipt {
  throw new Error(`command hook 未注入: ${auth.principalId}:${envelope.type}`);
}

function idHook(prefix: string): string {
  throw new Error(`id hook 未注入: ${prefix}`);
}

function tokenHook(kind: "session" | "ticket"): string {
  throw new Error(`token hook 未注入: ${kind}`);
}

export interface AuthorityPort {
  readonly commands: {
    execute: typeof executeCommandHook;
  };
}

/** 存档服务在传输层使用的最小视图；具体实现由 host/module-catalog 绑定。 */
export interface SnapshotRecordView {
  readonly snapshotId: string;
  readonly sourceBranchId: string;
  readonly frozenBranchId: string;
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly label: string;
  readonly createdAt: string;
}

export interface ServerIdentity {
  readonly token: string;
  readonly auth: AuthContext;
}

/** 注入钩子的类型锚点；实现体不会被调用，只用于保留参数与返回类型。 */
function pauseHook(operationId: string, expectedRunVersion: number): ClockView {
  void operationId;
  void expectedRunVersion;
  throw new Error(`pause hook 未注入: ${operationId}:${expectedRunVersion}`);
}

function resumeHook(operationId: string, expectedRunVersion: number): ClockView {
  void operationId;
  void expectedRunVersion;
  throw new Error(`resume hook 未注入: ${operationId}:${expectedRunVersion}`);
}

interface SnapshotCreateArgs {
  readonly sourceBranchId: string;
  readonly label: string;
  readonly createdBy: string;
}

interface SnapshotRestoreArgs {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
}

function createSnapshotHook(input: SnapshotCreateArgs): { readonly snapshotId: string; readonly worldTick: number } {
  void input;
  throw new Error(`save hook 未注入: ${input.sourceBranchId}`);
}

function restoreSnapshotHook(input: SnapshotRestoreArgs): { readonly branchId: string } {
  void input;
  throw new Error(`restore hook 未注入: ${input.snapshotId}`);
}

function resetHook(): { readonly branchId: string; readonly clock: ClockView } {
  throw new Error("reset hook 未注入");
}

/** 玩家会话读取请求：认证主体、对方主体与分页游标都由调用方给出。 */
export interface ConversationReadQuery {
  readonly principalId: string;
  readonly agentId: string;
  readonly beforeSeq: number | null;
  readonly limit: number;
}

/** 一条会话对白的只读来源；附带逐主体送达 tick，供传输层按调用主体过滤未送达内容。 */
export interface ConversationSourceLine {
  readonly seq: number;
  readonly dialogueId: string;
  readonly speakerId: string;
  readonly text: string;
  readonly channel: "face-to-face" | "relay";
  readonly worldTick: number;
  readonly deliveries: readonly {
    readonly principalId: string;
    readonly deliverAtTick: number;
  }[];
}

/**
 * 会话读取端口：宿主为每个方法绑定只读事务与已授权的通信端口。
 * 选择会话、分页与送达过滤都在传输层完成，端口本身不裁决可见性。
 */
export interface ConversationReadPort {
  worldTick(): number;
  conversationsOf(principalId: string): readonly string[];
  conversationMessages(conversationId: string, limit: number): readonly ConversationSourceLine[];
  speakerName(principalId: string): string;
}

export interface ServerAppOptions {
  readonly authority: AuthorityPort;
  readonly storage: StoragePort;
  readonly worldId: string;
  readonly branchId: string;
  /** 服务端 realm 的已解析装配；只含模块身份与能力，不含模块配置。 */
  readonly assembly: ResolvedModuleSet;
  /** 浏览器 realm 的已解析装配；未接线时按装配资源不存在处理。 */
  readonly sessionAssembly?: {
    readonly client: ResolvedModuleSet;
    readonly console: ResolvedModuleSet;
  };
  /** 玩家可选开局；未接线时不返回开局选项。 */
  readonly starts?: () => readonly StartOption[];
  /** 玩家会话读取端口；未接线时返回服务未就绪。 */
  readonly conversation?: ConversationReadPort;
  readonly projection: () => PlayerProjection;
  readonly clock: () => ClockView;
  readonly pause: typeof pauseHook;
  readonly resume: typeof resumeHook;
  readonly save: {
    createSnapshot: typeof createSnapshotHook;
    listSnapshots: () => readonly SnapshotRecordView[];
    restoreSnapshot: typeof restoreSnapshotHook;
  };
  readonly reset: typeof resetHook;
  readonly identities: readonly ServerIdentity[];
  readonly ids: typeof idHook;
  readonly tokens: typeof tokenHook;
  readonly allowedOrigins?: readonly string[];
  readonly onBranchChanged?: typeof onBranchChangedHook;
  readonly healthStatus?: () => "starting" | "ready" | "degraded";
  /** 认证、票据与过期判断使用的当前毫秒时间；默认 Date.now，测试可注入。 */
  readonly now?: () => number;
}

/** 会话的稳定身份；令牌只用于 HTTP 认证，撤销按 sessionId 匹配。 */
interface Session {
  readonly sessionId: string;
  readonly auth: AuthContext;
  readonly token: string;
  readonly expiresAt: number;
}

/** 一次性 WS 票据，只记录绑定的会话与失效时间。 */
interface StreamTicket {
  readonly sessionId: string;
  readonly expiresAt: number;
}

/** 重放缓冲中的一条玩家投影增量。 */
interface ReplayFrame {
  readonly streamSeq: number;
  readonly projectionVersion: number;
  readonly set: Record<string, unknown>;
}

/** 每个 (session, channel) 独立的有界重放缓冲，绑定分支与代次。 */
interface ReplayBuffer {
  readonly sessionId: string;
  readonly channel: StreamChannel;
  generation: number;
  branchId: string;
  readonly frames: ReplayFrame[];
}

/** 已握手连接；只有订阅集合内的频道才接收推送。 */
interface Connection {
  readonly sessionId: string;
  readonly channels: readonly StreamChannel[];
  readonly subscriptions: Set<StreamChannel>;
}

const playerChannel: StreamChannel = "player";
const replayLimit = 200;
const sessionTtlMs = 12 * 60 * 60 * 1000;
const ticketTtlMs = 30_000;

/** 按会话角色计算可订阅频道；玩家会话只允许玩家频道。 */
function channelsFor(auth: AuthContext): StreamChannel[] {
  if (auth.kind === "player") {
    return [playerChannel];
  }
  const channels = new Set<StreamChannel>();
  if (auth.roles.includes("operator") || auth.roles.includes("researcher")) {
    channels.add("console.health");
  }
  if (auth.roles.includes("researcher")) {
    channels.add("console.timeline");
    channels.add("console.turns");
  }
  return [...channels];
}

function onBranchChangedHook(nextBranchId: string): void {
  if (nextBranchId.length === 0) {
    throw new Error("分支 ID 不能为空");
  }
}

const playerCommandTypes = new Set([
  "campaign.start",
  "dialogue.say",
  "information.share",
  "agreement.propose",
  "agreement.respond",
  "task.dispatch",
  "task.cancel",
]);

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

function receiptOf(row: Record<string, unknown>): CommandReceipt {
  const raw = row["receipt_json"];
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return commandReceiptSchema.parse(value);
}

/** 会话分页未指定 limit 时取投影同样的窗口；上限由公共 schema 固定为 100。 */
const defaultConversationLimit = 50;

/**
 * append 帧的单条内容：只携带新增的一条对白或提醒，不复制整份投影。
 * 投影本身仍由 snapshot/delta 维护；重连按快照与增量重建，不重放 append。
 */
interface AppendItem {
  readonly kind: "dialogue" | "notification";
  readonly item: ConversationLine | PlayerNotificationView;
}

/** 提醒的稳定键；派生提醒的 worldTick 会随 tick 重算，不参与同一提醒的识别。 */
function notificationKey(item: PlayerNotificationView): string {
  return `${item.kind}\u0000${item.text}`;
}

/**
 * 找出上次发布后新增的对白与提醒。
 * 对白按 dialogueId 去重；提醒按稳定键做多重集差，避免同一持续状态在每个 tick 重复推送。
 */
function appendedItems(previous: PlayerProjection, next: PlayerProjection): readonly AppendItem[] {
  const known = new Set(previous.conversations.map((line) => line.dialogueId));
  const items: AppendItem[] = [];
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

/** 解析会话分页查询；只接受非负整数，非法值返回 null 由路由按 400 处理。 */
function conversationQueryOf(query: unknown): ConversationQuery | null {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return null;
  }
  const record = query as { readonly beforeSeq?: unknown; readonly limit?: unknown };
  const numberValue = (value: unknown): number | undefined | null => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  };
  const beforeSeq = numberValue(record.beforeSeq);
  const limit = numberValue(record.limit);
  if (beforeSeq === null || limit === null) {
    return null;
  }
  const parsed = conversationQuerySchema.safeParse({
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(limit === undefined ? {} : { limit }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 读取玩家与指定主体最近一次交换所在的会话。
 * 只选择双方共同参与且由最近一次交换确定的会话，再按 seq 游标与送达 tick 裁剪对白；
 * 找不到共同会话时返回 null，由路由按资源不存在处理。
 */
function readPlayerConversation(port: ConversationReadPort, query: ConversationReadQuery): ConversationResponse | null {
  const ownConversations = new Set(port.conversationsOf(query.principalId));
  let selectedConversationId: string | null = null;
  let selectedLastLine: ConversationSourceLine | null = null;
  for (const conversationId of port.conversationsOf(query.agentId)) {
    if (!ownConversations.has(conversationId)) {
      continue;
    }
    const lastLine = port.conversationMessages(conversationId, 1).at(-1);
    if (lastLine === undefined) {
      continue;
    }
    if (
      selectedLastLine === null ||
      lastLine.worldTick > selectedLastLine.worldTick ||
      (lastLine.worldTick === selectedLastLine.worldTick && conversationId > (selectedConversationId ?? ""))
    ) {
      selectedConversationId = conversationId;
      selectedLastLine = lastLine;
    }
  }
  if (selectedConversationId === null || selectedLastLine === null) {
    return null;
  }
  const tick = port.worldTick();
  const total = selectedLastLine.seq + 1;
  const before = query.beforeSeq ?? total;
  // 端口只支持从尾部读取；seq 从 0 连续递增，按尾部窗口回退到游标之前。
  const window = Math.max(0, total - before) + query.limit;
  const lines: ConversationLine[] = [];
  for (const line of port.conversationMessages(selectedConversationId, window)) {
    if (line.seq >= before) {
      continue;
    }
    const delivery = line.deliveries.find((candidate) => candidate.principalId === query.principalId);
    if (delivery === undefined || delivery.deliverAtTick > tick) {
      continue;
    }
    lines.push({
      seq: line.seq,
      dialogueId: line.dialogueId,
      speakerId: line.speakerId,
      speakerName: port.speakerName(line.speakerId),
      text: line.text,
      worldTick: line.worldTick,
      channel: line.channel,
    });
  }
  return { conversationId: selectedConversationId, lines: lines.slice(-query.limit) };
}

export interface ServerApp extends FastifyInstance {
  notifyWorldChanged(): void;
}

/** 构建服务端应用；调用方负责打开存储、装配模块与启动 worker。 */
export async function createServerApp(options: ServerAppOptions): Promise<ServerApp> {
  const app = Fastify({ logger: false });
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173"]);
  await app.register(cors, { origin: [...allowedOrigins] });
  await app.register(websocket);
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  const sessionById = new Map<string, Session>();
  const tickets = new Map<string, StreamTicket>();
  const connections = new Map<WebSocket, Connection>();
  const replayBuffers = new Map<string, ReplayBuffer>();
  const identityByToken = new Map(options.identities.map((identity) => [identity.token, identity]));
  let branchId = options.branchId;
  let generation = 0;
  let streamSeq = 0;
  let projectionVersion = 0;
  /** 最近一次成功发布的投影；用于识别新增对白与提醒。分支切换后重新建立基线。 */
  let lastProjection: PlayerProjection | null = options.projection();

  /** 统一非 2xx 载荷：错误码、可重试标记与安全文案；不含内部细节或敏感上下文。 */
  const sendHttpError = (reply: FastifyReply, status: number, code: ErrorCode, safeMessage: string): FastifyReply =>
    reply.code(status).send(
      errorResponseSchema.parse({
        error: { code, retryable: false, safeMessage, traceId: null, detailsArtifactRef: null },
      }),
    );

  /** 玩家接口只接受玩家会话；控制台角色统一按 403 拒绝。 */
  const requirePlayer = (session: Session, reply: FastifyReply): boolean => {
    if (session.auth.kind === "player") {
      return true;
    }
    sendHttpError(reply, 403, "forbidden", "当前角色无权访问玩家接口");
    return false;
  };

  /** 控制台会话：持有任一控制台角色；玩家会话不能读取控制台装配。 */
  const isConsoleSession = (session: Session): boolean =>
    session.auth.roles.some((role) => role === "operator" || role === "researcher" || role === "evaluator");

  /** 关闭连接；对已关闭或半关闭的连接不抛错。 */
  const closeSocket = (socket: WebSocket, code: number, reason: string): void => {
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
  };

  const sendPayload = (socket: WebSocket, payload: string): void => {
    try {
      socket.send(payload);
    } catch {
      closeSocket(socket, 1012, "stream unavailable");
    }
  };

  const sendMessage = (socket: WebSocket, message: Record<string, unknown>): void => {
    sendPayload(socket, JSON.stringify(message));
  };

  const sendError = (socket: WebSocket, code: ErrorCode, safeMessage: string): void => {
    sendMessage(socket, { type: "error", code, safeMessage });
  };

  const bufferKey = (sessionId: string, channel: StreamChannel): string => `${sessionId}\u0000${channel}`;

  const resetReplayBuffer = (buffer: ReplayBuffer): void => {
    buffer.generation = generation;
    buffer.branchId = branchId;
    buffer.frames.length = 0;
  };

  const ensureReplayBuffer = (sessionId: string, channel: StreamChannel): ReplayBuffer => {
    const key = bufferKey(sessionId, channel);
    const existing = replayBuffers.get(key);
    if (existing !== undefined) {
      if (existing.generation !== generation || existing.branchId !== branchId) {
        resetReplayBuffer(existing);
      }
      return existing;
    }
    const created: ReplayBuffer = { sessionId, channel, generation, branchId, frames: [] };
    replayBuffers.set(key, created);
    return created;
  };

  /** 按当前分支、代次与最新序号筛选连续增量；不满足时返回 null，由调用方改发快照。 */
  const selectReplay = (buffer: ReplayBuffer, fromStreamSeq: number | null): readonly ReplayFrame[] | null => {
    if (fromStreamSeq === null || buffer.generation !== generation || buffer.branchId !== branchId) {
      return null;
    }
    const frames = buffer.frames.filter((frame) => frame.streamSeq > fromStreamSeq);
    const first = frames.at(0);
    const last = frames.at(-1);
    if (first === undefined || last === undefined) {
      return null;
    }
    if (first.streamSeq !== fromStreamSeq + 1 || last.streamSeq !== streamSeq) {
      return null;
    }
    return frames;
  };

  /**
   * 撤销会话：删除会话与绑定票据，关闭该会话的全部连接并丢弃重放缓冲。
   * 同一会话重复注销时直接返回，不抛错。
   */
  const revokeSession = (sessionId: string, reason: string): void => {
    const session = sessionById.get(sessionId);
    if (session !== undefined) {
      sessionById.delete(sessionId);
      if (sessions.get(session.token) === session) {
        sessions.delete(session.token);
      }
    }
    for (const [ticketValue, ticket] of [...tickets]) {
      if (ticket.sessionId === sessionId) {
        tickets.delete(ticketValue);
      }
    }
    for (const [socket, connection] of [...connections]) {
      if (connection.sessionId !== sessionId) {
        continue;
      }
      connections.delete(socket);
      closeSocket(socket, 4401, reason);
    }
    for (const [key, buffer] of [...replayBuffers]) {
      if (buffer.sessionId === sessionId) {
        replayBuffers.delete(key);
      }
    }
  };

  /** 返回仍有效的会话；已过期或已注销时返回 null，并顺带撤销过期会话。 */
  const activeSession = (sessionId: string): Session | null => {
    const session = sessionById.get(sessionId);
    if (session === undefined) {
      return null;
    }
    if (session.expiresAt <= now()) {
      revokeSession(sessionId, "session expired");
      return null;
    }
    return session;
  };

  const sendSnapshot = (socket: WebSocket, channel: StreamChannel): void => {
    if (channel !== playerChannel) {
      // 控制台频道没有投影快照，订阅后等待增量事件。
      return;
    }
    let projection: PlayerProjection;
    try {
      projection = options.projection();
    } catch {
      closeSocket(socket, 1012, "projection unavailable");
      return;
    }
    sendMessage(socket, { type: "snapshot", channel, streamSeq, projectionVersion, data: projection });
  };

  const publishDelta = (): boolean => {
    let projection: PlayerProjection;
    try {
      projection = options.projection();
    } catch (error) {
      if (error instanceof Error && error.message.includes("尚未初始化")) {
        return false;
      }
      throw error;
    }
    const appends = lastProjection === null ? [] : appendedItems(lastProjection, projection);
    lastProjection = projection;
    streamSeq += 1;
    projectionVersion += 1;
    const set = { ...projection } as Record<string, unknown>;
    const frame: ReplayFrame = { streamSeq, projectionVersion, set };
    for (const buffer of replayBuffers.values()) {
      if (buffer.channel !== playerChannel) {
        continue;
      }
      if (buffer.generation !== generation || buffer.branchId !== branchId) {
        resetReplayBuffer(buffer);
      }
      buffer.frames.push(frame);
      if (buffer.frames.length > replayLimit) {
        buffer.frames.shift();
      }
    }
    const payload = JSON.stringify({ type: "delta", channel: playerChannel, ...frame });
    for (const [socket, connection] of [...connections]) {
      if (!connection.subscriptions.has(playerChannel) || activeSession(connection.sessionId) === null) {
        continue;
      }
      sendPayload(socket, payload);
    }
    // 新对白与新提醒按单条推送；同一 streamSeq 是与本次投影发布对应的版本。
    for (const append of appends) {
      const appendPayload = JSON.stringify({
        type: "append",
        channel: playerChannel,
        streamSeq,
        kind: append.kind,
        item: append.item,
      });
      for (const [socket, connection] of [...connections]) {
        if (!connection.subscriptions.has(playerChannel) || activeSession(connection.sessionId) === null) {
          continue;
        }
        sendPayload(socket, appendPayload);
      }
    }
    return true;
  };

  /** 分支切换：递增代次与序号，清空旧分支缓冲，并向已订阅连接强制发送快照。 */
  const applyBranchChange = (nextBranchId: string): void => {
    branchId = nextBranchId;
    generation += 1;
    streamSeq += 1;
    projectionVersion += 1;
    // 旧分支的投影不再可作为新增判断基线。
    lastProjection = null;
    for (const buffer of replayBuffers.values()) {
      resetReplayBuffer(buffer);
    }
    options.onBranchChanged?.(nextBranchId);
    for (const [socket, connection] of [...connections]) {
      if (activeSession(connection.sessionId) === null) {
        continue;
      }
      for (const channel of [...connection.subscriptions]) {
        sendSnapshot(socket, channel);
      }
    }
  };

  const handleStreamMessage = (socket: WebSocket, data: Buffer): void => {
    const connection = connections.get(socket);
    if (connection === undefined) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      sendError(socket, "validation", "消息不是 JSON");
      return;
    }
    const parsed = clientStreamMessageSchema.safeParse(message);
    if (!parsed.success) {
      sendError(socket, "validation", "消息格式不合法");
      return;
    }
    const value = parsed.data;
    if (value.type === "ping") {
      sendMessage(socket, { type: "pong" });
      return;
    }
    if (value.type === "ack") {
      return;
    }
    if (activeSession(connection.sessionId) === null) {
      closeSocket(socket, 4401, "session expired");
      return;
    }
    if (!connection.channels.includes(value.channel)) {
      sendError(socket, "forbidden", "频道不可用");
      return;
    }
    const buffer = ensureReplayBuffer(connection.sessionId, value.channel);
    const replay = selectReplay(buffer, value.fromStreamSeq);
    connection.subscriptions.add(value.channel);
    if (replay === null) {
      // 无可连续补发的增量时以完整快照重建基线。
      buffer.frames.length = 0;
      sendSnapshot(socket, value.channel);
      return;
    }
    for (const frame of replay) {
      sendPayload(socket, JSON.stringify({ type: "delta", channel: value.channel, ...frame }));
    }
  };

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      sendHttpError(reply, 403, "forbidden", "Origin 不被允许");
    }
  });

  const authenticate = (request: FastifyRequest, reply: FastifyReply): Session | null => {
    const token = bearer(request);
    const session = token === null ? undefined : sessions.get(token);
    if (session === undefined) {
      sendHttpError(reply, 401, "unauthenticated", "缺少或无效会话");
      return null;
    }
    if (session.expiresAt <= now()) {
      revokeSession(session.sessionId, "session expired");
      sendHttpError(reply, 401, "unauthenticated", "会话已过期");
      return null;
    }
    return { ...session, auth: { ...session.auth, branchId } };
  };

  app.get("/api/v1/health", () => healthResponseSchema.parse({ status: options.healthStatus?.() ?? "ready", protocolVersion: "1" }));

  app.post("/api/v1/auth/login", (request, reply) => {
    const body = loginRequestSchema.parse(request.body);
    const identity = identityByToken.get(body.token);
    if (identity === undefined) {
      return sendHttpError(reply, 401, "unauthenticated", "登录令牌无效");
    }
    const session: Session = {
      sessionId: options.ids("ses"),
      auth: identity.auth,
      token: options.tokens("session"),
      expiresAt: now() + sessionTtlMs,
    };
    sessions.set(session.token, session);
    sessionById.set(session.sessionId, session);
    return loginResponseSchema.parse({
      sessionToken: session.token,
      principalId: identity.auth.principalId,
      roles: identity.auth.roles as Array<"player" | "operator" | "researcher" | "evaluator">,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  app.post("/api/v1/auth/logout", (request, reply) => {
    const token = bearer(request);
    if (token === null) {
      return sendHttpError(reply, 401, "unauthenticated", "缺少或无效会话");
    }
    // 注销按会话身份撤销且幂等：并发或重复注销不报错。
    const session = sessions.get(token);
    if (session !== undefined) {
      revokeSession(session.sessionId, "logged out");
    }
    return { ok: true };
  });

  app.get("/api/v1/session", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const descriptor: SessionDescriptor = {
      principalId: session.auth.principalId,
      roles: session.auth.roles as Array<"player" | "operator" | "researcher" | "evaluator">,
      worldId: options.worldId,
      branchId,
      protocolVersion: "1",
      serverAssembly: options.assembly,
      clientAssembly: options.sessionAssembly?.client ?? null,
    };
    return descriptor;
  });

  app.get("/api/v1/session/assembly", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const query = sessionAssemblyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendHttpError(reply, 400, "validation", "realm 必须是 client 或 console");
    }
    if (query.data.realm === "console" && !isConsoleSession(session)) {
      return sendHttpError(reply, 403, "realm-violation", "当前会话不能读取控制台装配");
    }
    const assembly =
      query.data.realm === "client" ? options.sessionAssembly?.client : options.sessionAssembly?.console;
    if (assembly === undefined) {
      return sendHttpError(reply, 404, "not-found", "装配资源不存在");
    }
    return sessionAssemblyResponseSchema.parse(assembly);
  });

  app.post("/api/v1/commands", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const envelope = commandEnvelopeSchema.parse(request.body);
    if (session.auth.kind === "player" && !playerCommandTypes.has(envelope.type)) {
      return sendHttpError(reply, 403, "forbidden", "玩家不能使用该命令");
    }
    const receipt = options.authority.commands.execute(session.auth, envelope);
    try {
      publishDelta();
    } catch (error) {
      app.log.error(error, "投影发布失败");
    }
    return commandReceiptSchema.parse(receipt);
  });

  app.get("/api/v1/commands/:commandId", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const params = request.params as { readonly commandId: string };
    const row = options.storage.transact((tx) =>
      tx.get("SELECT receipt_json FROM command_receipts WHERE branch_id = ? AND principal_id = ? AND command_id = ?", [
        session.auth.branchId,
        session.auth.principalId,
        params.commandId,
      ]),
    );
    if (row === null) {
      return sendHttpError(reply, 404, "not-found", "回执不存在");
    }
    return receiptOf(row);
  });

  app.get("/api/v1/world/view", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    return { streamSeq, projectionVersion, projection: options.projection() };
  });

  app.get("/api/v1/campaign", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    // 开局前 projection.campaign 为 null，只返回可选开局；不因缺少 campaign 返回 404。
    return campaignResponseSchema.parse({
      campaign: options.projection().campaign,
      starts: [...(options.starts?.() ?? [])],
    });
  });

  app.get("/api/v1/conversations/:agentId", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const port = options.conversation;
    if (port === undefined) {
      return sendHttpError(reply, 503, "not-ready", "会话读取尚未就绪");
    }
    const params = request.params as { readonly agentId?: string };
    const agentId = params.agentId ?? "";
    if (agentId.length === 0) {
      return sendHttpError(reply, 404, "not-found", "会话不存在");
    }
    const query = conversationQueryOf(request.query);
    if (query === null) {
      return sendHttpError(reply, 400, "validation", "分页参数不合法");
    }
    const conversation = readPlayerConversation(port, {
      principalId: session.auth.principalId,
      agentId,
      beforeSeq: query.beforeSeq ?? null,
      limit: query.limit ?? defaultConversationLimit,
    });
    if (conversation === null) {
      return sendHttpError(reply, 404, "not-found", "会话不存在");
    }
    return conversationResponseSchema.parse(conversation);
  });

  app.post("/api/v1/campaign/pause", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly operationId: string; readonly expectedRunVersion: number };
    const clock = options.pause(body.operationId, body.expectedRunVersion);
    publishDelta();
    return clock;
  });

  app.post("/api/v1/campaign/resume", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly operationId: string; readonly expectedRunVersion: number };
    const clock = options.resume(body.operationId, body.expectedRunVersion);
    publishDelta();
    return clock;
  });

  app.post("/api/v1/campaign/snapshots", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly label: string };
    const snapshot = options.save.createSnapshot({
      sourceBranchId: branchId,
      label: body.label,
      createdBy: session.auth.principalId,
    });
    return { snapshotId: snapshot.snapshotId, worldTick: snapshot.worldTick };
  });

  app.get("/api/v1/campaign/snapshots", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const snapshots = options.save.listSnapshots() as readonly SnapshotRecordView[];
    return {
      snapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        label: snapshot.label,
        worldTick: snapshot.worldTick,
        createdAt: snapshot.createdAt,
      })),
    };
  });

  app.post("/api/v1/campaign/restore", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const body = request.body as { readonly snapshotId: string; readonly runId?: string };
    const restored = options.save.restoreSnapshot({ snapshotId: body.snapshotId, createdBy: session.auth.principalId, ...(body.runId === undefined ? {} : { runId: body.runId }) });
    applyBranchChange(restored.branchId);
    return { branchId: restored.branchId, clock: options.clock() };
  });

  app.post("/api/v1/campaign/reset", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const reset = options.reset();
    applyBranchChange(reset.branchId);
    return { branchId: reset.branchId, clock: reset.clock };
  });

  app.post("/api/v1/streams/ticket", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const ticket = options.tokens("ticket");
    const expiresAt = now() + ticketTtlMs;
    tickets.set(ticket, { sessionId: session.sessionId, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.get("/api/v1/streams", { websocket: true }, (socket, request) => {
    const query = request.query as { readonly ticket?: string };
    const ticketValue = typeof query.ticket === "string" ? query.ticket : undefined;
    const ticket = ticketValue === undefined ? undefined : tickets.get(ticketValue);
    if (ticketValue !== undefined) {
      // 票据一次性使用：无论后续校验是否通过都不再可用。
      tickets.delete(ticketValue);
    }
    if (ticket === undefined || ticket.expiresAt <= now()) {
      closeSocket(socket, 4401, "invalid ticket");
      return;
    }
    // 握手时重新确认会话仍存在且未过期，并按当前角色重算可用频道。
    const session = activeSession(ticket.sessionId);
    if (session === null) {
      closeSocket(socket, 4401, "invalid ticket");
      return;
    }
    const channels = channelsFor(session.auth);
    connections.set(socket, { sessionId: session.sessionId, channels, subscriptions: new Set() });
    socket.on("close", () => {
      connections.delete(socket);
    });
    socket.on("error", () => {
      connections.delete(socket);
    });
    socket.on("message", (data: Buffer) => {
      handleStreamMessage(socket, data);
    });
    sendMessage(socket, {
      type: "hello",
      protocolVersion: "1",
      principalId: session.auth.principalId,
      channels,
    });
  });

  app.get("/api/v1/console/health", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (session.auth.kind === "player") {
      return sendHttpError(reply, 403, "forbidden", "玩家不能访问控制台");
    }
    return { status: "ready", modules: [], queues: { turnsQueued: 0, jobsDue: 0 } };
  });

  app.setErrorHandler((error, _request, reply) => {
    const value = error as { readonly statusCode?: number; readonly message?: string };
    const status = typeof value.statusCode === "number" ? value.statusCode : 500;
    reply.code(status).send({
      code: status >= 500 ? "internal-error" : "invalid-request",
      safeMessage: status >= 500 ? "服务器内部错误" : (value.message ?? "请求不合法"),
    });
  });

  app.decorate("notifyWorldChanged", () => {
    publishDelta();
  });

  return app as unknown as ServerApp;
}
