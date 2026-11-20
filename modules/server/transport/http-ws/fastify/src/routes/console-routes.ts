/**
 * 注册控制台首批只读接口：健康总览、模块目录、装配详情、时间线与 Agent 摘要。
 * 依赖认证会话、当前角色、宿主只读控制台端口与公共响应 schema。
 * 禁止在页面接口中写入世界、泄露凭据，或由运营角色读取研究员专属时间线。
 */
import {
  agentsResponseSchema,
  assembliesResponseSchema,
  assemblyDetailResponseSchema,
  consoleHealthResponseSchema,
  modulesResponseSchema,
  realmQuerySchema,
  timelineResponseSchema,
} from "@ai-npc/contracts";
import {
  authenticate,
  requireConsoleRole,
  sendHttpError,
} from "./context";
import type { RouteContext } from "./context";

const dashboardRoles = ["operator", "researcher"] as const;
const researchRoles = ["researcher"] as const;
const maxTimelineTypesLength = 512;
const maxTimelineTypesCount = 20;

function queryText(query: unknown, key: string): string | undefined {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return undefined;
  }
  const value = (query as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function queryInteger(query: unknown, key: string, fallback: number): number | null {
  const raw = queryText(query, key);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function queryCsv(
  query: unknown,
  key: string,
  maxLength: number,
  maxItems: number,
): string[] | null | undefined {
  const raw = queryText(query, key);
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length > maxLength) {
    return null;
  }
  // 长度上界保证拆分结果有界，扫描器仍可能把规范化步骤误判为无界循环。
  // nosemgrep
  const values = raw.split(",");
  return values.length <= maxItems && values.every((value) => value.length > 0)
    ? values
    : null;
}

export function registerConsoleRoutes(context: RouteContext): void {
  const { app, branch, options } = context;

  app.get("/api/v1/console/health", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, dashboardRoles)) {
      return;
    }
    if (options.console === undefined) {
      return { status: "ready", modules: [], queues: { turnsQueued: 0, jobsDue: 0 } };
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
    const fromSeq = queryInteger(request.query, "fromSeq", 0);
    const limit = queryInteger(request.query, "limit", 100);
    if (fromSeq === null || fromSeq < 0 || limit === null || limit < 1 || limit > 200) {
      return sendHttpError(reply, "validation", "fromSeq 或 limit 不合法");
    }
    const types = queryCsv(
      request.query,
      "types",
      maxTimelineTypesLength,
      maxTimelineTypesCount,
    );
    if (types === null) {
      return sendHttpError(reply, "validation", "types 数量或长度不合法");
    }
    const agentId = queryText(request.query, "agentId");
    const nodeId = queryText(request.query, "nodeId");
    const branchId = queryText(request.query, "branchId") ?? branch.branchId;
    return timelineResponseSchema.parse(
      options.console.timeline({
        branchId,
        fromSeq,
        limit,
        ...(types === undefined ? {} : { types }),
        ...(agentId === undefined ? {} : { agentId }),
        ...(nodeId === undefined ? {} : { nodeId }),
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
    const branchId = queryText(request.query, "branchId");
    if (branchId === undefined) {
      return sendHttpError(reply, "validation", "branchId 不能为空");
    }
    return agentsResponseSchema.parse(options.console.agents(branchId));
  });
}
