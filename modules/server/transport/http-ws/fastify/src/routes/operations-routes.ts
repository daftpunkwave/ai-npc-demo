/**
 * 核心职责：注册玩家自助的 campaign 时钟暂停/继续、快照创建与列表、恢复与重新开局入口。
 * 交互契约：依赖玩家入口守卫与共享的 campaign 运营路由注册器；路径固定在 /api/v1/campaign。
 * 约束与禁忌：禁止在此重算幂等结果、直接改在线分支或跳过玩家入口裁决。
 */
import { registerCampaignOperations } from "./campaign-operations";
import { requirePlayer } from "./context";
import type { RouteContext } from "./context";

export function registerOperationsRoutes(context: RouteContext): void {
  registerCampaignOperations(context, {
    prefix: "/api/v1/campaign",
    authorize: (_context, _request, session, reply) => requirePlayer(context, session, reply),
    includeReset: true,
  });
}
