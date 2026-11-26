/**
 * 核心职责：注册模型布局列表、去密钥详情、按角色路由与草稿静态预检入口。
 * 交互契约：依赖控制台角色守卫与宿主模型布局端口；不在传输层读取配置文件或发起供应商请求。
 * 约束与禁忌：禁止泄露凭据正文，禁止让研究员执行草稿校验或让玩家进入控制台端点。
 */
import {
  modelLayoutRoutesResponseSchema,
  modelLayoutValidateRequestSchema,
  modelLayoutValidateResponseSchema,
  modelLayoutsResponseSchema,
  modelLayoutViewSchema,
} from "@world-prism/contracts";
import { authenticate, requireConsoleRole, sendHttpError } from "./context";
import type { RouteContext } from "./context";

const readRoles = ["operator", "researcher"] as const;
const writeRoles = ["operator"] as const;

function layoutIdOf(params: unknown): string {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return "";
  const value = (params as Readonly<Record<string, unknown>>)["layoutId"];
  return typeof value === "string" ? value : "";
}

export function registerConsoleModelRoutes(context: RouteContext): void {
  const { app, options } = context;

  app.get("/api/v1/console/model-layouts", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, readRoles)) return;
    if (options.console?.modelLayouts === undefined) return sendHttpError(reply, "not-ready", "模型布局目录尚未就绪");
    return modelLayoutsResponseSchema.parse(options.console.modelLayouts());
  });

  app.get("/api/v1/console/model-layouts/:layoutId/routes", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, readRoles)) return;
    if (options.console?.modelRoutes === undefined) return sendHttpError(reply, "not-ready", "模型路由视图尚未就绪");
    const layoutId = layoutIdOf(request.params);
    if (layoutId.length === 0) return sendHttpError(reply, "validation", "layoutId 不能为空");
    return modelLayoutRoutesResponseSchema.parse(options.console.modelRoutes(layoutId));
  });

  app.get("/api/v1/console/model-layouts/:layoutId", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, readRoles)) return;
    if (options.console?.modelLayout === undefined) return sendHttpError(reply, "not-ready", "模型布局详情尚未就绪");
    const layoutId = layoutIdOf(request.params);
    if (layoutId.length === 0) return sendHttpError(reply, "validation", "layoutId 不能为空");
    return modelLayoutViewSchema.parse(options.console.modelLayout(layoutId));
  });

  app.post("/api/v1/console/model-layouts/validate", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, writeRoles)) return;
    if (options.console?.validateModelLayout === undefined) {
      return sendHttpError(reply, "not-ready", "模型布局校验尚未就绪");
    }
    const parsed = modelLayoutValidateRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendHttpError(reply, "validation", "模型布局请求结构不合法");
    return modelLayoutValidateResponseSchema.parse(options.console.validateModelLayout(parsed.data.layout));
  });
}
