/**
 * 注册 campaign 时钟、快照、恢复与在线名册休眠/唤醒路由：玩家自助入口与控制台运营入口共享同一套事务与推送语义，
 * 只由调用方注入不同的鉴权守卫、路径前缀与可选的在线分支限制。
 * 依赖认证会话、权限守卫、运营回调与流中心分支切换通知。
 * 禁止在传输层重算幂等结果、直接改在线分支，或让未通过守卫的请求进入运营回调。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  campaignResetRequestSchema,
  campaignResetResponseSchema,
  clockControlRequestSchema,
  clockResponseSchema,
  clockStepRequestSchema,
  onlineRosterOperationRequestSchema,
  onlineRosterOperationResponseSchema,
  onlineRosterViewSchema,
  restoreDryRunResponseSchema,
  snapshotCreateRequestSchema,
  snapshotCreateResponseSchema,
  snapshotListResponseSchema,
  snapshotRestoreRequestSchema,
  snapshotRestoreResponseSchema,
} from "@world-prism/contracts";
import { authenticate, sendHttpError } from "./context";
import type { RouteContext } from "./context";
import type { HttpSession } from "./contracts";

/** 单个路由的鉴权守卫；守卫自行写入拒绝响应并返回 false。 */
export type CampaignOperationGuard = (
  context: RouteContext,
  request: FastifyRequest,
  session: HttpSession,
  reply: FastifyReply,
) => boolean;

/** 一组 campaign 控制路由的入口配置：前缀、守卫与可选能力。 */
export interface CampaignOperationsRegistration {
  /** 不带尾部斜杠的路径前缀，例如 /api/v1/campaign 或 /api/v1/console/campaign。 */
  readonly prefix: string;
  /** 变更类操作（暂停、恢复、创建快照、恢复、重开）的入口守卫。 */
  readonly authorize: CampaignOperationGuard;
  /** 快照列表的入口守卫；缺省与变更类操作一致。 */
  readonly authorizeRead?: CampaignOperationGuard;
  /** 是否拒绝与在线分支不一致的 branchId；控制台入口启用，玩家入口不接受该参数。 */
  readonly restrictToOnlineBranch?: boolean;
  /** 是否注册“重新开局”；玩家入口启用，控制台入口不提供。 */
  readonly includeReset?: boolean;
  /** 是否注册“受控单步推进”；当前只有控制台运营入口提供。 */
  readonly includeStep?: boolean;
  /** 控制台恢复入口允许先执行只读 dry-run。 */
  readonly includeDryRun?: boolean;
  /** 是否注册在线名册的状态读取、休眠与唤醒；当前只有控制台运营入口提供。状态读取使用 authorizeRead。 */
  readonly includeRoster?: boolean;
}

/** 读取可选 branchId 查询参数：缺省返回 undefined，非法值返回 null 由路由按 400 拒绝。 */
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

/** 控制台入口当前只支持在线分支：显式传入其他分支时返回 400，不静默作用到错误世界。 */
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

export function registerCampaignOperations(
  context: RouteContext,
  registration: CampaignOperationsRegistration,
): void {
  const { app, hub, options, branch } = context;
  const authorizeRead = registration.authorizeRead ?? registration.authorize;

  /**
   * 推送投影变化；业务操作已经提交时，推送失败只安全上报并触发快照重建，
   * 不把成功结果改写成 HTTP 错误，也不让回调自身的异常冒泡。
   * 同时把「世界已变化」交给宿主回调，玩家命令与 tick 推进共用同一条通知路径。
   */
  const publishProjection = (): void => {
    hub.publishWithResync(context.reportInternalError);
    try {
      options.onWorldCommitted?.();
    } catch (error) {
      context.reportInternalError("世界变化通知失败", error);
    }
  };

  /** 认证并执行入口守卫；返回 null 表示已写入错误响应。 */
  const authorize = (
    request: FastifyRequest,
    reply: FastifyReply,
    guard: CampaignOperationGuard,
  ): HttpSession | null => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return null;
    }
    if (!guard(context, request, session, reply)) {
      return null;
    }
    if (
      registration.restrictToOnlineBranch === true &&
      !requireOnlineBranch(context, request, reply)
    ) {
      return null;
    }
    return session;
  };

  app.post(`${registration.prefix}/pause`, (request, reply) => {
    const session = authorize(request, reply, registration.authorize);
    if (session === null) {
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

  app.post(`${registration.prefix}/resume`, (request, reply) => {
    const session = authorize(request, reply, registration.authorize);
    if (session === null) {
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

  if (registration.includeStep === true) {
    app.post(`${registration.prefix}/step`, (request, reply) => {
      const session = authorize(request, reply, registration.authorize);
      if (session === null) {
        return;
      }
      const body = clockStepRequestSchema.safeParse(request.body);
      if (!body.success) {
        return sendHttpError(reply, "validation", "单步推进请求结构不合法");
      }
      const clock = options.step(
        body.data.operationId,
        body.data.expectedRunVersion,
        body.data.ticks,
        session.auth.principalId,
      );
      publishProjection();
      return clockResponseSchema.parse(clock);
    });
  }

  app.post(`${registration.prefix}/snapshots`, (request, reply) => {
    const session = authorize(request, reply, registration.authorize);
    if (session === null) {
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

  app.get(`${registration.prefix}/snapshots`, (request, reply) => {
    const session = authorize(request, reply, authorizeRead);
    if (session === null) {
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

  app.post(`${registration.prefix}/restore`, (request, reply) => {
    const session = authorize(request, reply, registration.authorize);
    if (session === null) {
      return;
    }
    // 权威请求契约只有一份：dryRun 可选，缺省即真正恢复。
    const body = snapshotRestoreRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendHttpError(reply, "validation", "恢复请求结构不合法");
    }
    if (body.data.dryRun === true) {
      // 预检只由开放该能力的入口提供。未开放时显式拒绝，不能把 dryRun: true
      // 当成真正恢复执行——那会让「只想看校验结果」的调用直接切换在线分支。
      if (registration.includeDryRun !== true) {
        return sendHttpError(reply, "validation", "该入口不提供恢复预检");
      }
      if (options.save.validateRestore === undefined) {
        return sendHttpError(reply, "not-ready", "恢复预检尚未就绪");
      }
      return restoreDryRunResponseSchema.parse(options.save.validateRestore(body.data.snapshotId));
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

  if (registration.includeRoster === true) {
    app.get(`${registration.prefix}/roster`, (request, reply) => {
      const session = authorize(request, reply, authorizeRead);
      if (session === null) {
        return;
      }
      if (options.roster === undefined) {
        return sendHttpError(reply, "not-ready", "在线名册接口尚未就绪");
      }
      return onlineRosterViewSchema.parse(options.roster.state());
    });

    for (const action of ["hibernate", "wake"] as const) {
      app.post(`${registration.prefix}/roster/${action}`, (request, reply) => {
        const session = authorize(request, reply, registration.authorize);
        if (session === null) {
          return;
        }
        const body = onlineRosterOperationRequestSchema.safeParse(request.body);
        if (!body.success) {
          return sendHttpError(reply, "validation", "名册操作请求结构不合法");
        }
        if (options.roster === undefined) {
          return sendHttpError(reply, "not-ready", "在线名册接口尚未就绪");
        }
        const result = options.roster[action](body.data.operationId, session.auth.principalId);
        // 休眠会先暂停时钟，唤醒改变名册激活状态：推送新时钟并通知宿主按新状态调度 Agent。
        publishProjection();
        return onlineRosterOperationResponseSchema.parse(result);
      });
    }
  }

  if (registration.includeReset === true) {
    app.post(`${registration.prefix}/reset`, (request, reply) => {
      const session = authorize(request, reply, registration.authorize);
      if (session === null) {
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
}
