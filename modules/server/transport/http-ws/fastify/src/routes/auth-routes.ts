/**
 * 注册认证与会话路由：登录、注销、当前会话与浏览器/控制台装配握手。
 * 依赖身份令牌表、流中心会话、权限端口的 console-session 裁决与公共 schema。
 * 禁止在登录响应里返回内部身份细节，也禁止让注销因重复调用而失败。
 */
import {
  loginRequestSchema,
  loginResponseSchema,
  sessionAssemblyQuerySchema,
  sessionAssemblyResponseSchema,
  type SessionDescriptor,
} from "@ai-npc/contracts";
import {
  authenticate,
  bearer,
  isConsoleSession,
  sendHttpError,
} from "./context";
import type { RouteContext } from "./context";

type SessionRole = "player" | "operator" | "researcher" | "evaluator";

export function registerAuthRoutes(context: RouteContext): void {
  const { app, hub, options, identityByToken, branch } = context;

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
      roles: identity.auth.roles as SessionRole[],
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
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    const descriptor: SessionDescriptor = {
      principalId: session.auth.principalId,
      roles: session.auth.roles as SessionRole[],
      worldId: options.worldId,
      branchId: branch.branchId,
      protocolVersion: "1",
      serverAssembly: options.assembly,
      clientAssembly: options.sessionAssembly?.client ?? null,
    };
    return descriptor;
  });

  app.get("/api/v1/session/assembly", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    const query = sessionAssemblyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendHttpError(reply, "validation", "realm 必须是 client 或 console");
    }
    if (query.data.realm === "console" && !isConsoleSession(context, session)) {
      return sendHttpError(reply, "realm-violation", "当前会话不能读取控制台装配");
    }
    const assembly =
      query.data.realm === "client" ? options.sessionAssembly?.client : options.sessionAssembly?.console;
    if (assembly === undefined) {
      return sendHttpError(reply, "not-found", "装配资源不存在");
    }
    return sessionAssemblyResponseSchema.parse(assembly);
  });
}
