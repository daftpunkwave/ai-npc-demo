/**
 * 核心职责：注册控制台运营的 campaign 时钟暂停与恢复、快照创建与列表、从快照恢复入口。
 * 交互契约：依赖控制台会话认证、X-Active-Role 角色裁决与共享的 campaign 运营路由注册器。
 * 约束与禁忌：禁止放行玩家角色、静默忽略非在线分支的 branchId，或在传输层重算幂等结果。
 */
import { registerCampaignOperations } from "./campaign-operations";
import { requireConsoleRole } from "./context";
import type { RouteContext } from "./context";

/** 时钟、快照创建与恢复仅 operator；快照列表额外允许 researcher 只读。 */
const operatorRoles = ["operator"] as const;
const snapshotReadRoles = ["operator", "researcher"] as const;

export function registerConsoleOperationsRoutes(context: RouteContext): void {
  registerCampaignOperations(context, {
    prefix: "/api/v1/console/campaign",
    authorize: (ctx, request, session, reply) =>
      requireConsoleRole(ctx, request, session, reply, operatorRoles),
    authorizeRead: (ctx, request, session, reply) =>
      requireConsoleRole(ctx, request, session, reply, snapshotReadRoles),
    restrictToOnlineBranch: true,
  });
}
