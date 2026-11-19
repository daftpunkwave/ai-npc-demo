/**
 * 注册控制台路由：当前只提供健康读数。
 * 依赖 X-Active-Role 与会话角色的授权裁决；不读取运营队列或模块清单。
 * 禁止用占位数据伪造模块与队列字段，也不在这里实现后续控制台能力。
 */
import { authenticate, requireConsole } from "./context";
import type { RouteContext } from "./context";

export function registerConsoleRoutes(context: RouteContext): void {
  const { app } = context;

  app.get("/api/v1/console/health", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requireConsole(context, request, session, reply)) {
      return;
    }
    // 完整字段与队列数据由后续控制台验收；这里只返回已实现的状态，不用伪造数据填充模块与队列。
    return { status: "ready", modules: [], queues: { turnsQueued: 0, jobsDue: 0 } };
  });
}
