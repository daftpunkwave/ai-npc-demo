/**
 * 核心职责：注册控制台运营入口的时钟暂停/继续、快照创建与列表、从快照恢复。
 * 交互契约：依赖认证会话、X-Active-Role 角色裁决、宿主运营回调与公共请求/响应 schema；
 * 操作主体与幂等键取自当前会话与请求体，分支缺省为在线分支。
 * 约束与禁忌：禁止放行玩家角色、静默忽略非在线分支的 branchId、在传输层重算幂等结果或直接改写在线别名。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  clockControlRequestSchema,
  clockResponseSchema,
  snapshotCreateRequestSchema,
  snapshotCreateResponseSchema,
  snapshotListResponseSchema,
  snapshotRestoreRequestSchema,
  snapshotRestoreResponseSchema,
} from "@ai-npc/contracts";
import { authenticate, requireConsoleRole, sendHttpError } from "./context";
import type { RouteContext } from "./context";

/** 时钟、快照创建与恢复仅 operator；快照列表额外允许 researcher 只读。 */
const operatorRoles = ["operator"] as const;
const snapshotReadRoles = ["operator", "researcher"] as const;

/**
 * 读取可选的 branchId 查询参数。
 * 缺省返回 undefined；提供了非字符串或空值返回 null，由路由按 400 拒绝而不是静默忽略。
 */
function queryBranchId(query: unknown): string | null | undefined {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return undefined;
  }
  const value = (query as Readonly<Record<string, unknown>>)["branchId"];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 控制台运营入口当前只支持在线分支。
 * 未传 branchId 时按在线分支处理；显式传入的其他分支返回 400，避免请求被静默作用到错误的世界上。
 */
function requireOnlineBranch(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const branchId = queryBranchId(request.query);
  if (branchId === null) {
    sendHttpError(reply, "validation", "branchId 必须是单个非空字符串");
    return false;
  }
  if (branchId === undefined || branchId === context.branch.branchId) {
    return true;
  }
  sendHttpError(reply, "validation", "当前版本只支持在线分支，branchId 必须与在线分支一致");
  return false;
}

export function registerConsoleOperationsRoutes(context: RouteContext): void {
  const { app, hub, options, branch } = context;

  /** 推送投影变化；业务操作已提交时，推送失败只安全上报并触发快照重建。 */
  const publishProjection = (): void => {
    hub.publishWithResync(context.reportInternalError);
  };

  app.post("/api/v1/console/campaign/pause", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, operatorRoles)) {
      return;
    }
    if (!requireOnlineBranch(context, request, reply)) {
      return;
    }
    const body = clockControlRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "时钟控制请求结构不合法");
    }
    const clock = options.pause(body.data.operationId, body.data.expectedRunVersion, session.auth.principalId);
    publishProjection();
    return clockResponseSchema.parse(clock);
  });

  app.post("/api/v1/console/campaign/resume", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, operatorRoles)) {
      return;
    }
    if (!requireOnlineBranch(context, request, reply)) {
      return;
    }
    const body = clockControlRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "时钟控制请求结构不合法");
    }
    const clock = options.resume(body.data.operationId, body.data.expectedRunVersion, session.auth.principalId);
    publishProjection();
    return clockResponseSchema.parse(clock);
  });

  app.post("/api/v1/console/campaign/snapshots", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, operatorRoles)) {
      return;
    }
    if (!requireOnlineBranch(context, request, reply)) {
      return;
    }
    const body = snapshotCreateRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "快照请求结构不合法");
    }
    const snapshot = options.save.createSnapshot({
      sourceBranchId: branch.branchId,
      label: body.data.label,
      createdBy: session.auth.principalId,
      operationId: body.data.operationId,
      principalId: session.auth.principalId,
    });
    // 快照在运行中会先暂停时钟；已订阅客户端需要立即看到新的时钟状态。
    publishProjection();
    return snapshotCreateResponseSchema.parse({ snapshotId: snapshot.snapshotId, worldTick: snapshot.worldTick });
  });

  app.get("/api/v1/console/campaign/snapshots", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, snapshotReadRoles)) {
      return;
    }
    if (!requireOnlineBranch(context, request, reply)) {
      return;
    }
    const snapshots = options.save.listSnapshots();
    return snapshotListResponseSchema.parse({
      snapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        label: snapshot.label,
        worldTick: snapshot.worldTick,
        day: Math.floor(snapshot.worldTick / 24) + 1,
        createdAt: snapshot.createdAt,
        createdBy: snapshot.createdBy,
      })),
    });
  });

  app.post("/api/v1/console/campaign/restore", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null || !requireConsoleRole(context, request, session, reply, operatorRoles)) {
      return;
    }
    if (!requireOnlineBranch(context, request, reply)) {
      return;
    }
    const body = snapshotRestoreRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "恢复请求结构不合法");
    }
    const restored = options.save.restoreSnapshot({
      snapshotId: body.data.snapshotId,
      createdBy: session.auth.principalId,
      operationId: body.data.operationId,
      principalId: session.auth.principalId,
    });
    // 幂等重放返回首次结果但不再切换分支；只有本次真正应用切换时才更新传输层分支与推送快照。
    if (restored.applied !== false && restored.branchId !== branch.branchId) {
      hub.applyBranchChange(restored.branchId);
    }
    return snapshotRestoreResponseSchema.parse({
      branchId: restored.branchId,
      clock: restored.clock ?? options.clock(),
    });
  });
}
