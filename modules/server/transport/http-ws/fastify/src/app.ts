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
import fastifyStatic from "@fastify/static";
import { DomainError, type Json, type StreamChannel } from "@ai-npc/contracts";
import { StreamHub } from "./stream-hub";
import { channelsFor, sendHttpError, type OnlineBranch, type RouteContext } from "./routes/context";
import { registerAuthRoutes } from "./routes/auth-routes";
import { registerConsoleOperationsRoutes } from "./routes/console-operations-routes";
import { registerConsoleRoutes } from "./routes/console-routes";
import { registerConsoleModelRoutes } from "./routes/console-model-routes";
import { registerConsoleResearchRoutes } from "./routes/console-research-routes";
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

/** ws 在接收帧超过 maxPayload 时抛出带该稳定错误码的 RangeError，并自行以 1009 发起关闭。 */
function isWebSocketPayloadTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
  );
}

/**
 * 统一错误出口：领域错误按自身 code/retryable 映射；请求体解析错误为 400 validation；
 * 其余未预期错误一律 500 plugin-failed，safeMessage 不携带内部细节。
 * 4xx 属于预期拒绝，不写内部错误；5xx 交宿主记录，避免静默失败。
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
      return sendHttpError(reply, error.code, error.safeMessage, error.retryable);
    }
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
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
  const app = Fastify({ logger: false });
  const report = (message: string, error: unknown): void => {
    try {
      options.onInternalError?.(message, error);
    } catch {
      // 宿主上报失败不能影响已经确定的 HTTP 响应或连接清理。
    }
  };
  const allowedOrigins = new Set(options.allowedOrigins ?? ["http://127.0.0.1:5173"]);
  await app.register(cors, { origin: [...allowedOrigins] });
  await app.register(websocket, {
    options: { maxPayload: maxWebSocketPayloadBytes },
    errorHandler: (error, socket) => {
      if (isWebSocketPayloadTooLarge(error)) {
        // ws 已按 1009 发起关闭；这里只审计，不再 terminate，避免关闭帧被丢弃后客户端只看到异常断开。
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
  const hub = new StreamHub({
    projection: () => options.projection(),
    worldId: options.worldId,
    channelSnapshot: consoleSnapshot,
    channelsFor: (auth) => channelsFor(options.accessPolicy, auth),
    ids: (prefix) => options.ids(prefix),
    tokens: (kind) => options.tokens(kind),
    now,
    ...(options.onPlayerConnectionsChanged === undefined
      ? {}
      : { onPlayerConnectionsChanged: options.onPlayerConnectionsChanged }),
    ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
    onBranchChanged: (nextBranchId) => {
      branch.branchId = nextBranchId;
      options.onBranchChanged?.(nextBranchId);
    },
  });
  hub.setBranch(branch.branchId);
  const consoleHealthTimer =
    options.console === undefined
      ? null
      : setInterval(() => {
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
    requestSpans.set(request, {
      traceId: options.ids("trc"),
      spanId: options.ids("spn"),
      startedAt: Date.now(),
    });
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      sendHttpError(reply, "forbidden", "Origin 不被允许");
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
  registerConsoleOperationsRoutes(context);
  registerErrorHandling(app, report, notFound);

  /** 最小接口的监听与关闭由传输适配器实现，宿主不接触具体框架类型。 */
  const listen = async (listenOptions: { readonly host: string; readonly port: number }): Promise<void> => {
    await app.listen({ host: listenOptions.host, port: listenOptions.port });
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
    inject,
    // tick 推进与断线自动暂停都会调用这里；推送失败不能反过来中断世界或打崩进程。
    notifyWorldChanged: () => {
      hub.publishWithResync(report);
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
