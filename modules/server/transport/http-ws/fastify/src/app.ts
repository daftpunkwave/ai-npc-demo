/**
 * 创建 Fastify HTTP/WS 应用：登录、会话、装配握手、玩家读接口、命令与回执、时钟控制、存档、玩家流与统一错误响应。
 * 依赖 authority、装配的权限端口、回执只读查询端口、投影/会话/开局/时钟/存档回调与身份令牌；不直接查存储表，会话、票据、增量与重放由 StreamHub 管理。
 * 禁止信任页面自报角色、在传输层内置角色白名单、绕过 Origin 校验或把内部错误细节返回给客户端。
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import {
  campaignResetRequestSchema,
  campaignResetResponseSchema,
  campaignResponseSchema,
  clockControlRequestSchema,
  clockResponseSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  consoleActiveRoleSchema,
  conversationQuerySchema,
  conversationResponseSchema,
  DomainError,
  errorResponseSchema,
  healthResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  sessionAssemblyQuerySchema,
  sessionAssemblyResponseSchema,
  snapshotCreateRequestSchema,
  snapshotCreateResponseSchema,
  snapshotRestoreRequestSchema,
  snapshotRestoreResponseSchema,
  streamChannelSchema,
  type AuthContext,
  type ClockView,
  type CommandEnvelope,
  type CommandReceipt,
  type ConversationLine,
  type ConversationQuery,
  type ConversationResponse,
  type ErrorCode,
  type Json,
  type PlayerProjection,
  type ResolvedModuleSet,
  type SessionDescriptor,
  type StartOption,
  type StreamChannel,
} from "@ai-npc/contracts";
import { StreamHub, type StreamSession, type StreamSocket, type StreamStats } from "./stream-hub";

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

/** 需要裁决的动作：玩家入口、命令、控制台接口、控制台会话握手与 WS 频道。 */
export type AccessAction = "player" | "command" | "console" | "console-session" | "channel";

/**
 * 权限裁决请求：主体与角色始终来自服务端会话，调用方只补充动作与目标。
 * 这里的结构与 platform.access-policy 端口一致，传输层不依赖具体实现包。
 */
export interface AccessRequest {
  readonly principalId: string;
  readonly role: string;
  readonly action: AccessAction;
  readonly commandType?: string;
  readonly channel?: string;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** 权限端口最小视图；角色白名单由装配的 provider 维护，传输层不内置。 */
export interface AccessPolicy {
  authorize(request: AccessRequest): AccessDecision;
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

/**
 * 命令回执只读查询端口；宿主绑定存储细节，传输层只按会话主体、分支与命令 ID 查询。
 * 未找到返回 null，由路由按资源不存在处理；端口不暴露写入或表结构。
 */
export interface CommandReceiptReadPort {
  read(principalId: string, branchId: string, commandId: string): CommandReceipt | null;
}

export interface ServerIdentity {
  readonly token: string;
  readonly auth: AuthContext;
}

/** 注入钩子的类型锚点；实现体不会被调用，只用于保留参数与返回类型。 */
function pauseHook(operationId: string, expectedRunVersion: number, principalId: string): ClockView {
  void principalId;
  throw new Error(`pause hook 未注入: ${operationId}:${expectedRunVersion}`);
}

function resumeHook(operationId: string, expectedRunVersion: number, principalId: string): ClockView {
  void principalId;
  throw new Error(`resume hook 未注入: ${operationId}:${expectedRunVersion}`);
}

interface SnapshotCreateArgs {
  readonly sourceBranchId: string;
  readonly label: string;
  readonly createdBy: string;
  /** 请求体提供的运营幂等键；与认证主体共同识别重试。 */
  readonly operationId: string;
  readonly principalId: string;
}

interface SnapshotRestoreArgs {
  readonly snapshotId: string;
  readonly createdBy: string;
  readonly runId?: string;
  readonly operationId: string;
  readonly principalId: string;
}

/** 恢复结果：宿主命中幂等记录时返回首次时钟，未提供时由传输层读取当前时钟。 */
interface RestoreSnapshotResult {
  readonly branchId: string;
  readonly clock?: ClockView;
}

function createSnapshotHook(input: SnapshotCreateArgs): { readonly snapshotId: string; readonly worldTick: number } {
  void input;
  throw new Error(`save hook 未注入: ${input.sourceBranchId}`);
}

function restoreSnapshotHook(input: SnapshotRestoreArgs): RestoreSnapshotResult {
  void input;
  throw new Error(`restore hook 未注入: ${input.snapshotId}`);
}

function resetHook(operationId: string, principalId: string): { readonly branchId: string; readonly clock: ClockView } {
  void principalId;
  throw new Error(`reset hook 未注入: ${operationId}`);
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
  /** 装配的权限端口；玩家、控制台与 WS 频道的裁决都经此端口。 */
  readonly accessPolicy: AccessPolicy;
  /** 命令回执只读查询端口；传输层不直接访问存储。 */
  readonly receipts: CommandReceiptReadPort;
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
  /** 玩家 WS 连接数变化；宿主据此在全部玩家断线超时后自动暂停。 */
  readonly onPlayerConnectionsChanged?: (connected: number) => void;
  readonly healthStatus?: () => "starting" | "ready" | "degraded";
  /** 认证、票据与过期判断使用的当前毫秒时间；默认 Date.now，测试可注入。 */
  readonly now?: () => number;
}

/**
 * 按策略端口与会话角色计算可订阅频道。
 * 候选频道取自公共契约枚举，逐个频道询问 provider；未获准的频道不进入 hello，也不能订阅。
 */
function channelsFor(policy: AccessPolicy, auth: AuthContext): StreamChannel[] {
  return streamChannelSchema.options.filter((channel) =>
    auth.roles.some(
      (role) =>
        policy.authorize({
          principalId: auth.principalId,
          role,
          action: "channel",
          channel,
        }).allowed,
    ),
  );
}

function onBranchChangedHook(nextBranchId: string): void {
  if (nextBranchId.length === 0) {
    throw new Error("分支 ID 不能为空");
  }
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

/** 会话分页未指定 limit 时取投影同样的窗口；上限由公共 schema 固定为 100。 */
const defaultConversationLimit = 50;

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

/** 传输层测试与嵌入式调用使用的 HTTP 方法集合。 */
export type ServerAppInjectMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** 注入请求的最小选项；语义与传输适配器一致，但不暴露其内部类型。 */
export interface ServerAppInjectOptions {
  readonly method: ServerAppInjectMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payload?: unknown;
}

/** 注入响应的最小视图；只保留状态码、响应头与 JSON 读取。 */
export interface ServerAppInjectResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly body: string;
  /** 解析后的响应体；调用方可按已知契约收窄，宿主不暴露框架的 any 默认值。 */
  json<T = Json>(): T;
}

/**
 * 传输层对宿主公开的最小应用接口：监听、关闭、测试注入与世界变化通知。
 * 不继承具体框架类型；宿主只依赖这些能力，监听与关闭由传输模块实现。
 */
export interface ServerApp {
  listen(options: { readonly host: string; readonly port: number }): Promise<void>;
  close(): Promise<void>;
  inject(options: ServerAppInjectOptions): Promise<ServerAppInjectResponse>;
  notifyWorldChanged(): void;
  /** 当前监听地址；尚未监听时返回 null，供测试建立真实连接。 */
  address(): { readonly host: string; readonly port: number } | null;
  /** 流会话、票据、连接与重放缓冲的计数；用于确认后台对象有界。 */
  streamStats(): StreamStats;
}

/** 构建服务端应用；调用方负责打开存储、装配模块与启动 worker。 */
export async function createServerApp(options: ServerAppOptions): Promise<ServerApp> {
  const app = Fastify({ logger: false });
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173"]);
  await app.register(cors, { origin: [...allowedOrigins] });
  await app.register(websocket);
  const now = options.now ?? (() => Date.now());
  const identityByToken = new Map(options.identities.map((identity) => [identity.token, identity]));
  let branchId = options.branchId;
  const hub = new StreamHub({
    projection: () => options.projection(),
    channelsFor: (auth) => channelsFor(options.accessPolicy, auth),
    ids: (prefix) => options.ids(prefix),
    tokens: (kind) => options.tokens(kind),
    now,
    ...(options.onPlayerConnectionsChanged === undefined
      ? {}
      : { onPlayerConnectionsChanged: options.onPlayerConnectionsChanged }),
    onBranchChanged: (nextBranchId) => {
      branchId = nextBranchId;
      options.onBranchChanged?.(nextBranchId);
    },
  });
  hub.setBranch(branchId);
  /** HTTP 会话视图复用流中心的会话结构；分支在认证时按当前在线入口刷新。 */
  type Session = StreamSession;

  /** 错误码到 HTTP 状态的唯一映射；业务规则拒绝仍返回 200 与 rejected receipt。 */
  const statusByErrorCode: Readonly<Record<ErrorCode, number>> = {
    unauthenticated: 401,
    forbidden: 403,
    validation: 400,
    "not-found": 404,
    paused: 503,
    "not-ready": 503,
    "invalid-state": 409,
    "budget-exhausted": 429,
    cancelled: 409,
    "idempotency-conflict": 409,
    "version-conflict": 409,
    "stale-controller": 409,
    "stale-turn": 409,
    "module-missing": 422,
    "capability-conflict": 422,
    "assembly-incompatible": 422,
    "realm-violation": 403,
    "plugin-failed": 500,
    "provider-failed": 500,
  };

  /** 统一非 2xx 载荷：错误码、可重试标记与安全文案；不含内部细节或敏感上下文。 */
  const sendHttpError = (
    reply: FastifyReply,
    code: ErrorCode,
    safeMessage: string,
    retryable = false,
  ): FastifyReply =>
    reply.code(statusByErrorCode[code]).send(
      errorResponseSchema.parse({
        error: { code, retryable, safeMessage, traceId: null, detailsArtifactRef: null },
      }),
    );

  /**
   * 玩家入口：会话持有的角色中任一角色经策略端口获准 player 动作才放行。
   * 控制台角色不会因同源地址或页面自报身份获得玩家入口。
   */
  const requirePlayer = (session: Session, reply: FastifyReply): boolean => {
    const allowed = session.auth.roles.some(
      (role) =>
        options.accessPolicy.authorize({
          principalId: session.auth.principalId,
          role,
          action: "player",
        }).allowed,
    );
    if (allowed) {
      return true;
    }
    sendHttpError(reply, "forbidden", "当前角色无权访问玩家接口");
    return false;
  };

  /**
   * 命令入口在调用网关前裁决：同一角色须同时获准玩家入口与命令类型。
   * 被拒请求不进入 authority，因此不写 receipt、不产生事件、不推进世界状态。
   */
  const requireCommand = (session: Session, commandType: string, reply: FastifyReply): boolean => {
    const allowed = session.auth.roles.some((role) => {
      const principalId = session.auth.principalId;
      return (
        options.accessPolicy.authorize({ principalId, role, action: "player" }).allowed &&
        options.accessPolicy.authorize({
          principalId,
          role,
          action: "command",
          commandType,
        }).allowed
      );
    });
    if (allowed) {
      return true;
    }
    sendHttpError(reply, "forbidden", "当前角色不能使用该命令");
    return false;
  };

  /**
   * 控制台入口：X-Active-Role 必须存在、属于该会话持有的角色，并由策略端口按当前角色裁决。
   * 请求头只用于选择会话内角色，不能扩大会话权限；缺失、非法或不匹配统一返回 403。
   */
  const requireConsole = (
    request: FastifyRequest,
    session: Session,
    reply: FastifyReply,
  ): boolean => {
    const header = request.headers["x-active-role"];
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== "string" || value.trim().length === 0) {
      sendHttpError(reply, "forbidden", "控制台请求缺少 X-Active-Role");
      return false;
    }
    const parsed = consoleActiveRoleSchema.safeParse(value.trim());
    if (!parsed.success) {
      sendHttpError(reply, "forbidden", "X-Active-Role 不是控制台角色");
      return false;
    }
    if (!session.auth.roles.includes(parsed.data)) {
      sendHttpError(reply, "forbidden", "当前会话不持有请求的角色");
      return false;
    }
    const decision = options.accessPolicy.authorize({
      principalId: session.auth.principalId,
      role: parsed.data,
      action: "console",
    });
    if (!decision.allowed) {
      sendHttpError(reply, "forbidden", "当前角色无权访问控制台接口");
      return false;
    }
    return true;
  };

  /** 控制台装配握手：会话持有的任一角色获准 console-session 动作即可读取。 */
  const isConsoleSession = (session: Session): boolean =>
    session.auth.roles.some(
      (role) =>
        options.accessPolicy.authorize({
          principalId: session.auth.principalId,
          role,
          action: "console-session",
        }).allowed,
    );

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      sendHttpError(reply, "forbidden", "Origin 不被允许");
    }
  });

  const authenticate = (request: FastifyRequest, reply: FastifyReply): Session | null => {
    const token = bearer(request);
    const session = token === null ? null : hub.authenticate(token);
    if (session === null) {
      sendHttpError(reply, "unauthenticated", "缺少或无效会话");
      return null;
    }
    return session;
  };

  app.get("/api/v1/health", () => healthResponseSchema.parse({ status: options.healthStatus?.() ?? "ready", protocolVersion: "1" }));

  app.post("/api/v1/auth/login", (request, reply) => {
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "登录请求结构不合法");
    }
    const identity = identityByToken.get(body.data.token);
    if (identity === undefined) {
      return sendHttpError(reply, "unauthenticated", "登录令牌无效");
    }
    const session = hub.login(identity);
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
      return sendHttpError(reply, "unauthenticated", "缺少或无效会话");
    }
    // 注销按会话身份撤销且幂等：并发或重复注销不报错。
    hub.logout(token);
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
      return sendHttpError(reply, "validation", "realm 必须是 client 或 console");
    }
    if (query.data.realm === "console" && !isConsoleSession(session)) {
      return sendHttpError(reply, "realm-violation", "当前会话不能读取控制台装配");
    }
    const assembly =
      query.data.realm === "client" ? options.sessionAssembly?.client : options.sessionAssembly?.console;
    if (assembly === undefined) {
      return sendHttpError(reply, "not-found", "装配资源不存在");
    }
    return sessionAssemblyResponseSchema.parse(assembly);
  });

  app.post("/api/v1/commands", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const envelope = commandEnvelopeSchema.safeParse(request.body);
    if (!envelope.success) {
      return sendHttpError(reply, "validation", "命令信封结构不合法");
    }
    if (!requireCommand(session, envelope.data.type, reply)) {
      return;
    }
    const receipt = commandReceiptSchema.parse(options.authority.commands.execute(session.auth, envelope.data));
    // 同一 commandId 换 payload 是幂等冲突而不是业务拒绝：不返回 200 rejected receipt。
    if (receipt.commandStatus === "rejected" && receipt.reasonCode === "idempotency-conflict") {
      return sendHttpError(reply, "idempotency-conflict", receipt.safeMessage ?? "命令 ID 已被不同内容使用");
    }
    try {
      hub.publish();
    } catch (error) {
      app.log.error(error, "投影发布失败");
    }
    return receipt;
  });

  app.get("/api/v1/commands/:commandId", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const params = request.params as { readonly commandId: string };
    // 主体与分支取自认证会话；传输层只经注入的只读端口取回执，不访问存储表。
    const receipt = options.receipts.read(session.auth.principalId, session.auth.branchId, params.commandId);
    if (receipt === null) {
      return sendHttpError(reply, "not-found", "回执不存在");
    }
    return receipt;
  });

  app.get("/api/v1/world/view", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const state = hub.streamState();
    return { streamSeq: state.streamSeq, projectionVersion: state.projectionVersion, projection: options.projection() };
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
      return sendHttpError(reply, "not-ready", "会话读取尚未就绪");
    }
    const params = request.params as { readonly agentId?: string };
    const agentId = params.agentId ?? "";
    if (agentId.length === 0) {
      return sendHttpError(reply, "not-found", "会话不存在");
    }
    const query = conversationQueryOf(request.query);
    if (query === null) {
      return sendHttpError(reply, "validation", "分页参数不合法");
    }
    const conversation = readPlayerConversation(port, {
      principalId: session.auth.principalId,
      agentId,
      beforeSeq: query.beforeSeq ?? null,
      limit: query.limit ?? defaultConversationLimit,
    });
    if (conversation === null) {
      return sendHttpError(reply, "not-found", "会话不存在");
    }
    return conversationResponseSchema.parse(conversation);
  });

  app.post("/api/v1/campaign/pause", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const body = clockControlRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "时钟控制请求结构不合法");
    }
    const clock = options.pause(body.data.operationId, body.data.expectedRunVersion, session.auth.principalId);
    hub.publish();
    return clockResponseSchema.parse(clock);
  });

  app.post("/api/v1/campaign/resume", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const body = clockControlRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "时钟控制请求结构不合法");
    }
    const clock = options.resume(body.data.operationId, body.data.expectedRunVersion, session.auth.principalId);
    hub.publish();
    return clockResponseSchema.parse(clock);
  });

  app.post("/api/v1/campaign/snapshots", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const body = snapshotCreateRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "快照请求结构不合法");
    }
    const snapshot = options.save.createSnapshot({
      sourceBranchId: branchId,
      label: body.data.label,
      createdBy: session.auth.principalId,
      operationId: body.data.operationId,
      principalId: session.auth.principalId,
    });
    return snapshotCreateResponseSchema.parse({ snapshotId: snapshot.snapshotId, worldTick: snapshot.worldTick });
  });

  app.get("/api/v1/campaign/snapshots", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
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
    if (!requirePlayer(session, reply)) {
      return;
    }
    const body = snapshotRestoreRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "恢复请求结构不合法");
    }
    const restored = options.save.restoreSnapshot({
      snapshotId: body.data.snapshotId,
      createdBy: session.auth.principalId,
      operationId: body.data.operationId,
      principalId: session.auth.principalId,
    });
    // 幂等重放可能返回已经不在线的首次后继分支；只有真正切换时才更新传输层分支与推送快照。
    if (restored.branchId !== branchId) {
      hub.applyBranchChange(restored.branchId);
    }
    return snapshotRestoreResponseSchema.parse({
      branchId: restored.branchId,
      clock: restored.clock ?? options.clock(),
    });
  });

  app.post("/api/v1/campaign/reset", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(session, reply)) {
      return;
    }
    const body = campaignResetRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "重开请求结构不合法");
    }
    const reset = options.reset(body.data.operationId, session.auth.principalId);
    if (reset.branchId !== branchId) {
      hub.applyBranchChange(reset.branchId);
    }
    return campaignResetResponseSchema.parse({ branchId: reset.branchId });
  });

  // 票据与控制台共用：API 第 6 节对全部会话开放；可订阅频道在握手与订阅时另行裁决。
  app.post("/api/v1/streams/ticket", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    const ticket = hub.issueTicket(session.sessionId);
    return { ticket: ticket.ticket, expiresAt: new Date(ticket.expiresAt).toISOString() };
  });

  app.get("/api/v1/streams", { websocket: true }, (socket, request) => {
    const query = request.query as { readonly ticket?: string };
    const ticketValue = typeof query.ticket === "string" ? query.ticket : undefined;
    // 票据一次性使用与握手校验都由流中心完成；失败以 4401 关闭连接。
    hub.accept(socket as unknown as StreamSocket, ticketValue);
  });

  app.get("/api/v1/console/health", (request, reply) => {
    const session = authenticate(request, reply);
    if (session === null) {
      return;
    }
    if (!requireConsole(request, session, reply)) {
      return;
    }
    // 完整字段与队列数据由后续控制台验收；本次只补授权，不用伪造数据填充模块与队列。
    return { status: "ready", modules: [], queues: { turnsQueued: 0, jobsDue: 0 } };
  });

  /**
   * 统一错误出口：领域错误按自身 code/retryable 映射；请求体解析错误为 400 validation；
   * 其余未预期错误一律 500 plugin-failed，safeMessage 不携带内部细节。
   */
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return sendHttpError(reply, error.code, error.safeMessage, error.retryable);
    }
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
      return sendHttpError(reply, "validation", "请求结构不合法");
    }
    return sendHttpError(reply, "plugin-failed", "服务器内部错误");
  });

  app.setNotFoundHandler((_request, reply) => sendHttpError(reply, "not-found", "资源不存在"));

  /** 最小接口的监听与关闭由传输适配器实现，宿主不接触具体框架类型。 */
  const listen = async (listenOptions: { readonly host: string; readonly port: number }): Promise<void> => {
    await app.listen({ host: listenOptions.host, port: listenOptions.port });
  };

  const close = async (): Promise<void> => {
    try {
      await app.close();
    } finally {
      // 即使框架关闭抛错也要清除流中心的低频定时器与后台对象。
      hub.close();
    }
  };

  const inject = async (injectOptions: ServerAppInjectOptions): Promise<ServerAppInjectResponse> => {
    // 经方法调用保留框架实例的接收者；返回值收窄为最小响应视图。
    const runner = app as unknown as {
      inject(options: ServerAppInjectOptions): Promise<ServerAppInjectResponse>;
    };
    return runner.inject(injectOptions);
  };

  const address = (): { readonly host: string; readonly port: number } | null => {
    const value = app.server.address();
    if (value === null || typeof value === "string") {
      return null;
    }
    return { host: value.address, port: value.port };
  };

  return {
    listen,
    close,
    inject,
    notifyWorldChanged: () => {
      hub.publish();
    },
    address,
    streamStats: () => hub.stats(),
  };
}
