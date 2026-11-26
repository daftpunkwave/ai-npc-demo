/**
 * 创建 Fastify HTTP/WS 应用：装配流中心与路由上下文，按认证、玩家、运营、控制台运营、流与控制台域注册路由，
 * 并提供统一错误响应、监听/关闭/注入的最小接口。
 * 依赖认证、内容、玩家、运营、控制台运营、流与控制台路由模块，装配的权限端口与身份令牌；不直接查存储表。
 * 禁止信任页面自报角色、在传输层内置角色白名单、绕过 Origin 校验或把内部错误细节返回给客户端。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 类型签名与回调参数名用于表达调用契约。 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { DomainError, type Json, type StreamChannel } from "@ai-npc/contracts";
import { StreamHub } from "./stream-hub";
import { channelsFor, registerRequestTraceId, sendHttpError, type OnlineBranch, type RouteContext } from "./routes/context";
import { registerAuthRoutes } from "./routes/auth-routes";
import { registerConsoleOperationsRoutes } from "./routes/console-operations-routes";
import { registerConsoleRoutes } from "./routes/console-routes";
import { registerConsoleModelRoutes } from "./routes/console-model-routes";
import { registerConsoleEvaluationRoutes, registerConsoleResearchRoutes } from "./routes/console-research-routes";
import { registerContentRoutes } from "./routes/content-routes";
import { registerOperationsRoutes } from "./routes/operations-routes";
import { registerPlayerRoutes } from "./routes/player-routes";
import { registerStreamRoutes } from "./routes/stream-routes";
import { registerSystemRoutes } from "./routes/system-routes";
import type {
  ServerApp,
  ServerAppInjectOptions,
  ServerAppInjectResponse,
  ServerAppOptions,
} from "./routes/contracts";

export type {
  AccessAction,
  AccessDecision,
  AccessPolicy,
  AccessRequest,
  AuthorityPort,
  BranchChangedHook,
  BranchClockResult,
  ClockControlHook,
  ClockStepHook,
  CommandReceiptReadPort,
  ConversationReadPort,
  ConversationReadQuery,
  ConversationSourceLine,
  IdGenerator,
  ResetHook,
  RecordSpanInput,
  RestoreSnapshotResult,
  ServerApp,
  ServerAppInjectMethod,
  ServerAppInjectOptions,
  ServerAppInjectResponse,
  ServerAppOptions,
  ServerIdentity,
  SnapshotCreateArgs,
  SnapshotCreateHook,
  SnapshotCreateResult,
  SnapshotRecordView,
  SnapshotRestoreArgs,
  SnapshotRestoreHook,
  TokenIssuer,
} from "./routes/contracts";

/**
 * 客户端 WS 帧上限：客户端只发送 subscribe/ack/ping，公共 schema 不含文本载荷，
 * 合法帧只有数百字节；64 KiB 为后续可选字段留出余量，同时避免超长帧占用接收缓冲。
 */
const maxWebSocketPayloadBytes = 64 * 1024;

/**
 * HTTP 时间与连接维度上限。Fastify 默认把这些值设为 0（不限），
 * 本服务要求局部阻塞不扩散为整机不可用，因此逐项显式声明并写明依据。
 * 导出供测试锁定取值，避免后续重构把它们删回框架默认。
 */
export const httpTransportLimits = {
  /**
   * 单请求处理上限：最长合法请求是开局与恢复类命令、配置提交，正常远低于 1 秒。
   * 30 秒给慢磁盘与高负载留出余量，同时让慢速发送请求体与卡死的 handler 被打断。
   */
  requestTimeoutMs: 30_000,
  /**
   * socket 空闲上限：底层落到 `server.setTimeout()`（Node 的 socket 空闲超时），
   * 连接在该时长内没有任何读写活动即被关闭。它不约束「收齐请求头」——
   * 那由 Node 的 `headersTimeout` 管辖且 Fastify 未暴露为选项，本服务沿用其默认值。
   * 此处取值目的是让停在半开状态上的连接最终被回收。
   */
  connectionTimeoutMs: 30_000,
  /** handler 执行上限：与请求上限对齐，超时交错误处理器返回 plugin-failed。 */
  handlerTimeoutMs: 30_000,
  /**
   * 单连接请求数上限：本地单玩家场景一个连接远达不到该数量；
   * 设上限是为了让长连接不能无限复用，避免 keep-alive 连接永不释放。
   */
  maxRequestsPerSocket: 1_000,
  /** 请求体上限：最长的命令与配置提交小于 1 MiB，显式写出以免被误当成可随意放宽。 */
  bodyLimitBytes: 1024 * 1024,
} as const;

/**
 * 浏览器可发送的请求头白名单。会话令牌走 Authorization 头而非 Cookie，
 * 控制台角色由 X-Active-Role 声明；其余头不进入跨域允许面。
 */
const corsAllowedHeaders = ["authorization", "content-type", "x-active-role"] as const;

/** 实际使用的 HTTP 方法：路由只有查询与命令提交两类，预检需要 OPTIONS。 */
const corsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;

/**
 * 不参与请求次数限流的路径：健康检查与 WebSocket 升级。
 *
 * 健康检查无鉴权且供探活高频调用，限流会让探活本身变成故障源；
 * WebSocket 升级是长连接，请求次数不代表资源占用，由心跳与连接上限约束。
 * 其余路径一律限流——用豁免清单而不是白名单，新增路由默认受保护，
 * 遗漏只会表现为「本可以更宽松」，而不是「本应受保护却裸露」。
 */
function isRateLimitExempt(url: string): boolean {
  return url === "/api/v1/health" || url === "/api/v1/streams";
}

/** 需要限流的路由：除豁免清单外的全部 API 路径。 */
function isRateLimitedRoute(url: string): boolean {
  return url.startsWith("/api/v1/") && !isRateLimitExempt(url);
}

/** 从 Authorization 头取 Bearer 令牌；非该形态一律视为未提供。 */
function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}


/** ws 在接收帧超过 maxPayload 时抛出带该稳定错误码的 RangeError，并自行以 1009 发起关闭。 */
function isWebSocketPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
  );
}

/**
 * 框架级请求超时错误码。Fastify 在 handlerTimeout 触发时抛出该错误，
 * 语义是「本次请求未在期限内完成」，不是服务端缺陷，因此按可重试处理。
 */
const fastifyHandlerTimeoutCode = "FST_ERR_HANDLER_TIMEOUT";

/**
 * 判定框架请求超时错误。只按稳定错误码判断，不匹配错误文案，
 * 以免框架调整措辞后分类失效。
 */
function isHandlerTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === fastifyHandlerTimeoutCode
  );
}

/**
 * 统一错误出口：领域错误按自身 code/retryable 映射；请求体解析错误为 400 validation；
 * 框架请求超时按可重试失败返回，并在诊断中保留超时事实；
 * 其余未预期错误一律 500 plugin-failed，safeMessage 不携带内部细节。
 * 4xx 属于预期拒绝，不写内部错误；5xx 与超时交宿主记录，避免静默失败。
 * 未匹配路由交给调用方传入的 notFound 处理器，控制台据此区分静态资源与前端导航。
 */
function registerErrorHandling(
  app: FastifyInstance,
  report: (message: string, error: unknown) => void,
  notFound: (request: FastifyRequest, reply: FastifyReply) => unknown,
): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      if (error.code === "plugin-failed" || error.code === "provider-failed") {
        report("请求处理失败", error);
      }
      // 领域错误显式携带的关联字段优先于本次请求登记的 traceId：
      // 跨进程或延迟产生的错误记录的是它自己的 trace，不能被响应时的请求 trace 覆盖。
      return sendHttpError(reply, error.code, error.safeMessage, error.retryable, {
        traceId: error.traceId,
        detailsArtifactRef: error.detailsArtifactRef,
      });
    }
    if (isHandlerTimeoutError(error)) {
      // 超时只中止了本次请求的响应等待，无法取消 handler 内部已发起的异步工作；
      // 这里记录超时事实，并按可重试失败返回，避免客户端把它当成永久性错误。
      report("请求处理超时", error);
      return sendHttpError(reply, "plugin-failed", "请求处理超时", true);
    }
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    // 限流插件以 429 抛出：按统一错误格式返回。插件已在抛错前写入正确的 retry-after，
    // 这里不覆盖它；只把插件计算好的等待说明带进 safeMessage。
    if (statusCode === 429) {
      const pluginError = (error as { readonly error?: { readonly safeMessage?: unknown } }).error;
      const safeMessage = typeof pluginError?.safeMessage === "string"
        ? pluginError.safeMessage
        : "请求过于频繁，请稍后重试";
      return sendHttpError(reply, "budget-exhausted", safeMessage, true);
    }
    if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
      return sendHttpError(reply, "validation", "请求结构不合法");
    }
    report("请求处理失败", error);
    return sendHttpError(reply, "plugin-failed", "服务器内部错误");
  });
  app.setNotFoundHandler((request, reply) => notFound(request, reply));
}

/** 构建服务端应用；调用方负责打开存储、装配模块与启动 worker。 */
export async function createServerApp(options: ServerAppOptions): Promise<ServerApp> {
  const app = Fastify({
    logger: false,
    requestTimeout: httpTransportLimits.requestTimeoutMs,
    connectionTimeout: httpTransportLimits.connectionTimeoutMs,
    handlerTimeout: httpTransportLimits.handlerTimeoutMs,
    maxRequestsPerSocket: httpTransportLimits.maxRequestsPerSocket,
    bodyLimit: httpTransportLimits.bodyLimitBytes,
  });
  const report = (message: string, error: unknown): void => {
    try {
      options.onInternalError?.(message, error);
    } catch {
      // 宿主上报失败不能影响已经确定的 HTTP 响应或连接清理。
    }
  };
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173"]);
  // 跨域允许面全部显式声明，不依赖 @fastify/cors 的默认回显：
  // 方法锁定为实际路由使用的集合，头部锁定为会话与角色所需的最小集合；
  // 会话令牌走 Authorization 头而非 Cookie，因此 credentials 保持 false。
  await app.register(cors, {
    origin: [...allowedOrigins],
    methods: [...corsAllowedMethods],
    allowedHeaders: [...corsAllowedHeaders],
    credentials: false,
  });
  // 安全响应头对全部响应生效：禁止 MIME 嗅探、禁止被任何页面 iframe 嵌入、
  // 跨站不携带完整路径作为 Referer。CSP 只对浏览器文档类响应设置：
  // 它对 JSON 响应没有约束意义，给非文档响应加策略只会扩大误配面。
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    const contentType = reply.getHeader("content-type");
    if (typeof contentType === "string" && contentType.includes("text/html")) {
      // 静态产物只从同源加载脚本与样式；此处按构建产物实际形态收紧，
      // 不放开 unsafe-inline，产物若引入内联脚本会立即失败而不是静默放宽。
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    return payload;
  });
  /**
   * 速率限制按路由声明配额，读接口与写接口使用不同阈值。
   *
   * 判定分三类，逐路由在 `onRoute` 阶段决定，而不是在各路由注册器里各写一份：
   * - 写入口（命令、票据、登录、运营变更）：阈值显著低于读入口，这些路径会推进世界状态或消耗会话资源；
   * - 读入口（会话、内容、投影、回执、会话对白）：按会话主体的稳定窗口配额；
   * - 不参与限流：健康检查（无鉴权、供探活高频调用）与 WebSocket 升级（连接期内由心跳与连接上限约束）。
   *
   * 阈值可经 options.rateLimits 覆盖；分组覆盖项缺省时沿用同一分组的默认阈值，
   * 避免出现「覆盖了读阈值但写阈值突然变成 0」这类静默失效。
   */
  const rateLimitFor = (method: string): number =>
    method === "GET" || method === "HEAD"
      ? (options.rateLimits?.read ?? 60)
      : (options.rateLimits?.write ?? 10);
  // 配额键要按已验证的会话主体计，而流中心在本函数后半段才创建。
  // 这里用一个读取器推迟取值：键生成发生在请求处理期，届时 hub 必然已就绪。
  let sessionHub: StreamHub | null = null;
  const sessionTokenIdentity = (header: string | undefined): string | null => {
    if (sessionHub === null) {
      return null;
    }
    const token = bearerToken(header);
    if (token === null) {
      return null;
    }
    // 只返回已验证会话的主体：未认证或过期时返回 null，交给 IP 桶。
    return sessionHub.authenticate(token)?.auth.principalId ?? null;
  };
  app.addHook("onRoute", (route) => {
    const url = route.url;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    // WebSocket 升级不是可重复的请求-响应交互：连接生命周期内由心跳与连接上限约束，
    // 按请求次数限流只会在重连抖动时误伤正常恢复。
    if (route.websocket === true) {
      return;
    }
    if (!isRateLimitedRoute(url)) {
      return;
    }
    const write = methods.some((method) => method !== "GET" && method !== "HEAD");
    route.config = {
      ...route.config,
      rateLimit: { max: rateLimitFor(write ? "POST" : "GET"), timeWindow: "10 seconds" },
    };
  });
  await app.register(rateLimit, {
    global: false,
    max: options.rateLimits?.read ?? 60,
    timeWindow: "10 seconds",
    /**
     * 配额键必须只由服务端能验证的事实构成。
     *
     * 旧实现直接取 `Authorization` 头的后 24 个字符。该值在认证之前完全由请求方控制：
     * 每次换一个无效令牌就能落到新的计数器上，反复发送无效会话的请求永远不会被限流。
     * 正确做法是先用流中心的会话表验证令牌，只有已验证的会话才按主体计配额——
     * 此时 `principalId` 由服务端会话给出，伪造令牌换不到新桶。
     *
     * 未认证请求（缺失令牌、令牌无效、会话过期）统一落到 IP 桶：
     * 它们的共同特征是「服务端无法确认调用方是谁」，因此只能按来源地址收敛。
     */
    keyGenerator: (request) => {
      const principalId = sessionTokenIdentity(request.headers.authorization);
      return principalId === null ? `ip:${request.ip}` : `cred:${principalId}`;
    },
    errorResponseBuilder: (_request, context) => ({
      // 与项目统一错误格式一致：429 走 budget-exhausted，并带 retryAfter 秒数。
      statusCode: 429,
      error: {
        code: "budget-exhausted",
        retryable: true,
        safeMessage: `请求过于频繁，请等待 ${Math.ceil(context.ttl / 1000)} 秒`,
        traceId: null,
        detailsArtifactRef: null,
      },
    }),
  });
  await app.register(websocket, {
    options: { maxPayload: maxWebSocketPayloadBytes },
    errorHandler: (error, socket) => {
      if (isWebSocketPayloadTooLarge(error)) {
        // ws 已按 1009 发起关闭；这里只审计，不再 terminate，避免关闭帧被丢弃后客户端只看到异常断开。
        // 审计走与 HTTP 请求相同的观测写端口：一条结构化 span 落库后可查询，
        // 且只记录上限与关闭码，不含帧内容或票据，避免把凭据写进观测数据。
        const startedAt = Date.now();
        try {
          options.recordSpan?.({
            spanId: options.ids("spn"),
            traceId: options.ids("trc"),
            name: "ws.frame.over-limit",
            status: "error",
            startMs: startedAt,
            endMs: startedAt,
            attrs: { maxPayloadBytes: maxWebSocketPayloadBytes, closeCode: 1009 },
          });
        } catch (auditError) {
          report("WS 超限审计写入失败", auditError);
        }
        report("WS 帧超过上限", error);
        return;
      }
      // 其余连接错误保持框架默认的立即终止，交由流中心的 error 监听清理连接状态。
      socket.terminate();
    },
  });
  if (options.consoleStaticDir !== undefined) {
    await app.register(fastifyStatic, {
      // wildcard 模式让每个请求按请求路径直接读盘，而不是依赖注册瞬间的文件清单：
      // 控制台由 vite build --watch 并行构建，首次构建与每次热重建都会产生新的 hash 文件名。
      root: options.consoleStaticDir,
      prefix: "/console/",
      wildcard: true,
      decorateReply: true,
    });
    app.get("/console", (_request, reply) => reply.redirect("/console/"));
  }
  /**
   * 未匹配路由的兜底：控制台导航路径回退 index.html，其余一律 404 统一错误。
   *
   * 回退必须同时满足四个条件，任何一个不满足都退回 404：
   * - 方法是 GET 或 HEAD：其他方法不是导航请求，不能拿到 200 的 HTML；
   * - 路径以 `/console/` 开头；
   * - 末段不含扩展名：带扩展名的是资产请求，缺失时若以 200 text/html 冒充，
   *   浏览器会把 HTML 当 JS/CSS 执行并静默白屏；
   * - `index.html` 实际存在：入口文件缺失时（首次构建完成前、重建清空目录期间）
   *   直接 404，避免 sendFile 的 404 再次触发同一回退。
   *
   * `@fastify/static` 在 wildcard 模式已占用 `/console/*`，因此只能用 not-found 分流。
   */
  const notFound = (request: FastifyRequest, reply: FastifyReply): unknown => {
    const notFoundError = (): unknown => sendHttpError(reply, "not-found", "资源不存在");
    if (options.consoleStaticDir === undefined) {
      return notFoundError();
    }
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return notFoundError();
    }
    // 只取路径部分，并在解码后判断扩展名：`assets/main%2Ejs` 这类编码形式同样是资产请求。
    const pathname = request.url.split("?")[0] ?? "";
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      // 非法百分号编码不是导航路径，按资源不存在处理。
      return notFoundError();
    }
    const lastSegment = decodedPath.slice(decodedPath.lastIndexOf("/") + 1);
    if (!decodedPath.startsWith("/console/") || lastSegment.includes(".")) {
      return notFoundError();
    }
    if (options.consoleEntryExists !== undefined && !options.consoleEntryExists()) {
      return notFoundError();
    }
    return reply.sendFile("index.html");
  };
  const now = options.now ?? (() => Date.now());
  const identityByToken = new Map(options.identities.map((identity) => [identity.token, identity]));
  const branch: OnlineBranch = { branchId: options.branchId };
  const consoleSnapshot = (channel: StreamChannel): Json | null => {
    if (options.console === undefined) {
      return null;
    }
    if (channel === "console.health") {
      return options.console.health() as unknown as Json;
    }
    if (channel === "console.timeline") {
      return options.console.timeline({
        branchId: branch.branchId,
        fromSeq: 0,
        limit: 100,
        order: "desc",
      }) as unknown as Json;
    }
    return null;
  };
  /**
   * 频道可用性：只有真正能产出快照的控制台频道才接受订阅。
   * console.turns 虽已在权限表与消息契约中登记，但服务端尚无生产者；
   * 这里必须如实报告未实现，让客户端拿到 not-ready 而不是接受订阅后永远收不到帧。
   */
  const consoleChannelProvided = (channel: StreamChannel): boolean =>
    options.console !== undefined && (channel === "console.health" || channel === "console.timeline");
  const hub = new StreamHub({
    projection: () => options.projection(),
    worldId: options.worldId,
    channelSnapshot: consoleSnapshot,
    channelProvided: consoleChannelProvided,
    channelsFor: (auth) => channelsFor(options.accessPolicy, auth),
    ids: (prefix) => options.ids(prefix),
    tokens: (kind) => options.tokens(kind),
    now,
    ...(options.onPlayerConnectionsChanged === undefined
      ? {}
      : { onPlayerConnectionsChanged: options.onPlayerConnectionsChanged }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
    onBranchChanged: (nextBranchId) => {
      branch.branchId = nextBranchId;
      options.onBranchChanged?.(nextBranchId);
    },
  });
  hub.setBranch(branch.branchId);
  /**
   * 健康摘要定时广播：只在确有订阅者时构造。
   * health() 每次要跑两笔事务并重建模块清单，没有控制台页面打开时这份构造完全无人接收，
   * 因此订阅判断必须在调用 health() 之前，而不是等 publishConsole 内部的连接循环。
   */
  const consoleHealthTimer =
    options.console === undefined
      ? null
      : setInterval(() => {
          if (!hub.hasSubscriber("console.health")) {
            return;
          }
          try {
            hub.publishConsole("console.health", options.console?.health() as unknown as Json);
          } catch (error) {
            report("控制台健康推送失败", error);
          }
        }, 2_000);
  consoleHealthTimer?.unref();
  const context: RouteContext = { app, hub, options, identityByToken, branch, reportInternalError: report };
  const requestSpans = new WeakMap<
    object,
    { readonly traceId: string; readonly spanId: string; readonly startedAt: number }
  >();

  app.addHook("onRequest", async (request, reply) => {
    const span = {
      traceId: options.ids("trc"),
      spanId: options.ids("spn"),
      startedAt: Date.now(),
    };
    requestSpans.set(request, span);
    // 只有确实会写入请求 span 时才登记 traceId：未注入 recordSpan 时该 ID 查不到任何记录，
    // 返回它等于给出一个无法关联的伪标识，因此这种情况下错误响应保持 traceId 为 null。
    if (options.recordSpan !== undefined) {
      registerRequestTraceId(reply, span.traceId);
    }
    // 关闭已开始：新请求按 not-ready 拒绝，避免排空期间又有命令进入世界。
    // 健康检查豁免，让关闭期间的探活仍能读到 degraded/closed 事实而不是被误导为连接异常。
    if (closing && !request.url.startsWith("/api/v1/health")) {
      sendHttpError(reply, "not-ready", "服务端正在关闭，不再接受新请求");
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      sendHttpError(reply, "forbidden", "Origin 不被允许");
      return;
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const started = requestSpans.get(request);
    if (started === undefined || options.recordSpan === undefined) {
      return;
    }
    try {
      options.recordSpan({
        spanId: started.spanId,
        traceId: started.traceId,
        name: "http.request",
        status: reply.statusCode >= 500 ? "error" : "ok",
        startMs: started.startedAt,
        endMs: Date.now(),
        attrs: {
          route: request.routeOptions.url ?? request.url,
          status: reply.statusCode,
        },
      });
    } catch (error) {
      report("HTTP span 写入失败", error);
    }
  });

  registerSystemRoutes(context);
  registerAuthRoutes(context);
  registerContentRoutes(context);
  registerPlayerRoutes(context);
  registerOperationsRoutes(context);
  registerStreamRoutes(context);
  registerConsoleRoutes(context);
  registerConsoleModelRoutes(context);
  registerConsoleResearchRoutes(context);
  registerConsoleEvaluationRoutes(context);
  registerConsoleOperationsRoutes(context);
  registerErrorHandling(app, report, notFound);

  // 限流键需要按已验证会话的主体生成，hub 在此时才存在；接上后所有请求都能取到主体。
  sessionHub = hub;

  /** 最小接口的监听与关闭由传输适配器实现，宿主不接触具体框架类型。 */
  const listen = async (listenOptions: { readonly host: string; readonly port: number }): Promise<void> => {
    await app.listen({ host: listenOptions.host, port: listenOptions.port });
  };

  // 关闭开始后置位：onRequest 据此拒绝新请求，已有的处理中请求不受影响。
  let closing = false;
  const stopAccepting = (): void => {
    closing = true;
  };

  const close = async (): Promise<void> => {
    try {
      if (consoleHealthTimer !== null) {
        clearInterval(consoleHealthTimer);
      }
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
    stopAccepting,
    inject,
    // tick 推进与断线自动暂停都会调用这里；推送失败不能反过来中断世界或打崩进程。
    notifyWorldChanged: () => {
      hub.publishWithResync(report);
      // 时间线快照的构建包含两笔事务与上百条事件的解析排序，先确认有人订阅再算，
      // 否则控制台未打开时每次世界变化都要为无人接收的数据付费。
      if (!hub.hasSubscriber("console.timeline")) {
        return;
      }
      try {
        const timeline = consoleSnapshot("console.timeline");
        if (timeline !== null) {
          hub.publishConsole("console.timeline", timeline);
        }
      } catch (error) {
        report("控制台时间线推送失败", error);
      }
    },
    address,
    streamStats: () => hub.stats(),
  };
}
