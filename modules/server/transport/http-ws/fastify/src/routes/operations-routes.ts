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
  snapshotRestoreRequestSchema,
  snapshotRestoreResponseSchema,
} from "@ai-npc/contracts";
import { authenticate, requirePlayer, sendHttpError } from "./context";
import type { RouteContext } from "./context";

export function registerOperationsRoutes(context: RouteContext): void {
  const { app, hub, options, branch } = context;

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
    hub.publish();
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
    hub.publish();
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
    return {
      snapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        label: snapshot.label,
        worldTick: snapshot.worldTick,
        createdAt: snapshot.createdAt,
      })),
    };
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
    // 幂等重放可能返回已经不在线的首次后继分支；只有真正切换时才更新传输层分支与推送快照。
    if (restored.branchId !== branch.branchId) {
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
    if (reset.branchId !== branch.branchId) {
      hub.applyBranchChange(reset.branchId);
    }
    return campaignResetResponseSchema.parse({ branchId: reset.branchId });
  });
}
