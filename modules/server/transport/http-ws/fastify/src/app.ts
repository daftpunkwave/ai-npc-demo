/**
 * 创建 Fastify HTTP/WS 应用：装配流中心与路由上下文，按认证、玩家、运营、流与控制台域注册路由，
 * 并提供统一错误响应、监听/关闭/注入的最小接口。
 * 依赖 auth、玩家、运营、流与控制台路由模块，装配的权限端口与身份令牌；不直接查存储表。
 * 禁止信任页面自报角色、在传输层内置角色白名单、绕过 Origin 校验或把内部错误细节返回给客户端。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 类型签名与回调参数名用于表达调用契约。 */
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { DomainError } from "@ai-npc/contracts";
import { StreamHub } from "./stream-hub";
import { channelsFor, sendHttpError, type OnlineBranch, type RouteContext } from "./routes/context";
import { registerAuthRoutes } from "./routes/auth-routes";
import { registerConsoleRoutes } from "./routes/console-routes";
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
  CommandReceiptReadPort,
  ConversationReadPort,
  ConversationReadQuery,
  ConversationSourceLine,
  IdGenerator,
  ResetHook,
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
 * 统一错误出口：领域错误按自身 code/retryable 映射；请求体解析错误为 400 validation；
 * 其余未预期错误一律 500 plugin-failed，safeMessage 不携带内部细节。
 * 4xx 属于预期拒绝，不写内部错误；5xx 交宿主记录，避免静默失败。
 */
function registerErrorHandling(
  app: FastifyInstance,
  report: (message: string, error: unknown) => void,
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
  app.setNotFoundHandler((_request, reply) => sendHttpError(reply, "not-found", "资源不存在"));
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
  await app.register(websocket);
  const now = options.now ?? (() => Date.now());
  const identityByToken = new Map(options.identities.map((identity) => [identity.token, identity]));
  const branch: OnlineBranch = { branchId: options.branchId };
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
      branch.branchId = nextBranchId;
      options.onBranchChanged?.(nextBranchId);
    },
  });
  hub.setBranch(branch.branchId);
  const context: RouteContext = { app, hub, options, identityByToken, branch, reportInternalError: report };

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.has(origin)) {
      sendHttpError(reply, "forbidden", "Origin 不被允许");
    }
  });

  registerSystemRoutes(context);
  registerAuthRoutes(context);
  registerPlayerRoutes(context);
  registerOperationsRoutes(context);
  registerStreamRoutes(context);
  registerConsoleRoutes(context);
  registerErrorHandling(app, report);

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
    // tick 推进与断线自动暂停都会调用这里；推送失败不能反过来中断世界或打崩进程。
    notifyWorldChanged: () => {
      hub.publishWithResync(report);
    },
    address,
    streamStats: () => hub.stats(),
  };
}
