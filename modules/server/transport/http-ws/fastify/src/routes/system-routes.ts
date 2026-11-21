/**
 * 注册无需认证的系统路由：健康检查。
 * 依赖健康状态回调与公共响应 schema；不读取存储、不触发世界推进。
 * 禁止在此暴露模块清单、队列明细或内部状态；完整控制台契约由控制台路由负责。
 */
import { healthResponseSchema, protocolVersion } from "@ai-npc/contracts";
import type { RouteContext } from "./context";

export function registerSystemRoutes(context: RouteContext): void {
  const { app, options } = context;
  app.get(
    "/api/v1/health",
    () => healthResponseSchema.parse({ status: options.healthStatus?.() ?? "ready", protocolVersion }),
  );
}
