/**
 * 注册运营路由：时钟暂停/继续、快照创建与列表、恢复与重开。
 * 依赖认证会话、权限端口、运营回调（幂等键与主体）与流中心的分支切换通知。
 * 禁止在传输层重算幂等结果、直接改在线分支或跳过玩家入口裁决。
 */
import {
  campaignResetRequestSchema,
  campaignResetResponseSchema,
  clockControlRequestSchema,
  clockResponseSchema,
  snapshotCreateRequestSchema,
  snapshotCreateResponseSchema,
  snapshotListResponseSchema,
  snapshotRestoreRequestSchema,
  snapshotRestoreResponseSchema,
} from "@ai-npc/contracts";
import { authenticate, requirePlayer, sendHttpError } from "./context";
import type { RouteContext } from "./context";

export function registerOperationsRoutes(context: RouteContext): void {
  const { app, hub, options, branch } = context;

  /**
   * 推送投影变化；业务操作已经提交时，推送失败只记日志，不把成功结果改写成 HTTP 错误。
   * 客户端仍可经世界视图重新读取投影。
   */
  const publishProjection = (): void => {
    try {
      hub.publish();
    } catch (error) {
      options.onInternalError?.("投影发布失败", error);
    }
  };

  app.post("/api/v1/campaign/pause", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
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

  app.post("/api/v1/campaign/resume", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
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

  app.post("/api/v1/campaign/snapshots", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
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

  app.get("/api/v1/campaign/snapshots", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
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

  app.post("/api/v1/campaign/restore", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
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

  app.post("/api/v1/campaign/reset", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
      return;
    }
    const body = campaignResetRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "重开请求结构不合法");
    }
    const reset = options.reset(body.data.operationId, session.auth.principalId);
    // 幂等重放返回首次结果但不再切换分支；只有本次真正应用切换时才更新传输层分支与推送快照。
    if (reset.applied !== false && reset.branchId !== branch.branchId) {
      hub.applyBranchChange(reset.branchId);
    }
    return campaignResetResponseSchema.parse({ branchId: reset.branchId });
  });
}
