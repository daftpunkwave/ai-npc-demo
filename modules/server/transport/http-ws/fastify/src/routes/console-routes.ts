/**
 * 注册控制台首批只读接口：健康总览、模块目录、装配详情、时间线与 Agent 摘要。
 * 依赖认证会话、当前角色、宿主只读控制台端口与公共响应 schema。
 * 禁止在页面接口中写入世界、泄露凭据，或由运营角色读取研究员专属时间线。
 */
import {
  agentsQuerySchema,
  agentsResponseSchema,
  assembliesResponseSchema,
  assemblyDetailResponseSchema,
  consoleHealthResponseSchema,
  modulesResponseSchema,
  realmQuerySchema,
  timelineQuerySchema,
  timelineResponseSchema,
} from "@world-prism/contracts";
import {
  authenticate,
  requireConsoleRole,
  sendHttpError,
} from "./context";
import type { RouteContext } from "./context";
import { parseQuery, queryText } from "./query";

const dashboardRoles = ["operator", "researcher"] as const;
const researchRoles = ["researcher"] as const;

export function registerConsoleRoutes(context: RouteContext): void {
  const { app, branch, options } = context;

  app.get("/api/v1/console/health", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, dashboardRoles)) {
      return;
    }
    if (options.console === undefined) {
      // 没有控制台端口时不得返回伪造的 ready 摘要；交给统一 503 not-ready。
      return sendHttpError(reply, "not-ready", "控制台健康摘要尚未就绪");
    }
    return consoleHealthResponseSchema.parse(options.console.health());
  });

  app.get("/api/v1/console/modules", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, dashboardRoles)) {
      return;
    }
    if (options.console === undefined) {
      return sendHttpError(reply, "not-ready", "模块目录尚未就绪");
    }
    const realm = queryText(request.query, "realm");
    if (realm === undefined) {
      return modulesResponseSchema.parse(options.console.modules());
    }
    const parsed = realmQuerySchema.safeParse({ realm });
    if (!parsed.success) {
      return sendHttpError(reply, "validation", "realm 必须是 server、client 或 console");
    }
    return modulesResponseSchema.parse(options.console.modules(parsed.data.realm));
  });

  app.get("/api/v1/console/assemblies", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, dashboardRoles)) {
      return;
    }
    if (options.console === undefined) {
      return sendHttpError(reply, "not-ready", "装配目录尚未就绪");
    }
    return assembliesResponseSchema.parse({ assemblies: options.console.assemblies() });
  });

  app.get("/api/v1/console/assemblies/:assemblyId", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, dashboardRoles)) {
      return;
    }
    if (options.console === undefined) {
      return sendHttpError(reply, "not-ready", "装配目录尚未就绪");
    }
    const params = request.params as { readonly assemblyId?: string };
    const assemblyId = params.assemblyId ?? "";
    if (assemblyId.length === 0) {
      return sendHttpError(reply, "not-found", "装配不存在");
    }
    return assemblyDetailResponseSchema.parse(options.console.assembly(assemblyId));
  });

  app.get("/api/v1/console/timeline", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, researchRoles)) {
      return;
    }
    if (options.console === undefined) {
      return sendHttpError(reply, "not-ready", "观测服务尚未就绪");
    }
    // 查询字符串先规范化为 schema 的输入类型，边界一律由共享 schema 裁决：
    // 缺省 fromSeq/limit 走 schema 默认值，types 的数量与元素长度上限也只在契约里定义一次。
    const query = parseQuery(timelineQuerySchema, request.query);
    if (query === null) {
      return sendHttpError(reply, "validation", "fromSeq 或 limit 或 types 不合法");
    }
    const branchId = query.branchId ?? branch.branchId;
    return timelineResponseSchema.parse(
      options.console.timeline({
        branchId,
        fromSeq: query.fromSeq,
        limit: query.limit,
        ...(query.order === undefined ? {} : { order: query.order }),
        ...(query.types === undefined ? {} : { types: query.types }),
        ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
        ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId }),
      }),
    );
  });

  app.get("/api/v1/console/agents", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, researchRoles)) {
      return;
    }
    if (options.console === undefined) {
      return sendHttpError(reply, "not-ready", "观测服务尚未就绪");
    }
    // 与时间线共用同一条规范化 + 共享 schema 路径，避免再次出现手写校验与契约分裂。
    const query = parseQuery(agentsQuerySchema, request.query);
    if (query === null) {
      return sendHttpError(reply, "validation", "branchId 不能为空");
    }
    return agentsResponseSchema.parse(options.console.agents(query.branchId));
  });
}
