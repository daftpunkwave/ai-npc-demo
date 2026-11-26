/**
 * HTTP 路由的共享上下文与访问裁决助手：会话认证、角色裁决、统一错误响应与会话分页读取。
 * 依赖注入的权限端口、流中心会话与公共契约 schema；不注册路由、不持有应用状态。
 * 禁止信任页面自报角色、在传输层内置角色白名单或把内部错误细节返回给客户端。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  consoleActiveRoleSchema,
  conversationQuerySchema,
  errorResponseSchema,
  streamChannelSchema,
  type AuthContext,
  type ConversationLine,
  type ConversationQuery,
  type ConversationResponse,
  type ErrorCode,
  type StreamChannel,
} from "@ai-npc/contracts";
import type { StreamHub } from "../stream-hub";
import type {
  AccessPolicy,
  ConversationReadPort,
  ConversationReadQuery,
  ConversationSourceLine,
  ServerAppOptions,
  ServerIdentity,
  HttpSession,
} from "./contracts";

/**
 * 把一组裁决结果归并成一个结论，并区分「配置未覆盖该角色」与「角色合法但无权」。
 *
 * 两者都返回 403，响应体不区分，避免向调用方泄露角色存在性；
 * 但 `unknown-role` 说明 provider 的配置没有覆盖会话持有的角色，属于装配漂移，
 * 必须上报内部错误，否则它会被当成普通权限拒绝而长期无人发现。
 */
function decisionOutcome(
  decisions: readonly { readonly allowed: boolean; readonly reason: string }[],
): { readonly allowed: boolean; readonly misconfigured: boolean } {
  const allowed = decisions.some((decision) => decision.allowed);
  return {
    allowed,
    misconfigured:
      !allowed && decisions.some((decision) => decision.reason === "unknown-role"),
  };
}

/**
 * 命令或运营操作提交成功后通知世界变化：推送订阅者，并把信号交给宿主回调。
 * 玩家命令与 tick 推进走同一条通知路径，否则依赖该信号的订阅者只能等下一次巡检。
 */
export function notifyWorldCommitted(context: RouteContext): void {
  context.hub.publishWithResync(context.reportInternalError);
  try {
    context.options.onWorldCommitted?.();
  } catch (error) {
    context.reportInternalError("世界变化通知失败", error);
  }
}

/** 路由共享的在线入口：分支在恢复或重开后由流中心同步更新。 */
export interface OnlineBranch {
  branchId: string;
}

/** 路由上下文：应用实例、流中心、宿主选项、身份表与当前在线分支。 */
export interface RouteContext {
  readonly app: FastifyInstance;
  readonly hub: StreamHub;
  readonly options: ServerAppOptions;
  readonly identityByToken: ReadonlyMap<string, ServerIdentity>;
  readonly branch: OnlineBranch;
  /** 传输层内部错误的安全上报口；回调自身抛错不会改变已确定的 HTTP 响应或连接清理。 */
  // eslint-disable-next-line no-unused-vars -- 函数类型签名中的参数名只用于表达调用契约，运行时不会读取。
  readonly reportInternalError: (message: string, error: unknown) => void;
}

/** 错误码到 HTTP 状态的唯一映射；业务规则拒绝仍返回 200 与 rejected receipt。 */
const statusByErrorCode: Readonly<Record<ErrorCode, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  validation: 400,
  "not-found": 404,
  paused: 503,
  "not-ready": 503,
  "invalid-state": 409,
  "budget-exhausted": 429,
  cancelled: 409,
  "idempotency-conflict": 409,
  "version-conflict": 409,
  "stale-controller": 409,
  "stale-turn": 409,
  "module-missing": 422,
  "capability-conflict": 422,
  "assembly-incompatible": 422,
  "realm-violation": 403,
  "plugin-failed": 500,
  "provider-failed": 500,
};

/** 统一非 2xx 载荷的关联字段：缺省时不伪造成空串，由调用方给出本次请求的事实。 */
export interface HttpErrorContext {
  readonly traceId?: string | null;
  readonly detailsArtifactRef?: string | null;
}

/**
 * 本次请求的 traceId 登记表。
 *
 * 错误响应需要把 traceId 与已在 `trace_spans` 落库的请求 span 关联起来，
 * 但错误出口被上百处路由共用，逐处透传会迫使每个调用点重复读请求上下文。
 * 因此由 `onRequest` 钩子登记一次，`sendHttpError` 按 reply 取回；
 * 键是单次请求的 reply 对象，条目随请求对象一起被回收，不会跨请求泄漏。
 */
const traceIdByReply = new WeakMap<object, string>();

/** 在请求进入时登记本次请求的 traceId；未登记时错误响应的 traceId 保持 null。 */
export function registerRequestTraceId(reply: FastifyReply, traceId: string): void {
  traceIdByReply.set(reply, traceId);
}

/** 统一非 2xx 载荷：错误码、可重试标记与安全文案；不含内部细节或敏感上下文。 */
export function sendHttpError(
  reply: FastifyReply,
  code: ErrorCode,
  safeMessage: string,
  retryable = false,
  errorContext: HttpErrorContext = {},
): FastifyReply {
  // 显式传入的值优先；未提供时回落到本次请求登记的 traceId，使客户端能关联到已记录的 span。
  const traceId = errorContext.traceId ?? traceIdByReply.get(reply) ?? null;
  // eslint-disable-next-line security/detect-object-injection -- 错误码是内部 ErrorCode 枚举，索引来自受限字面量联合。
  return reply.code(statusByErrorCode[code]).send(
    errorResponseSchema.parse({
      error: {
        code,
        retryable,
        safeMessage,
        traceId,
        detailsArtifactRef: errorContext.detailsArtifactRef ?? null,
      },
    }),
  );
}

/**
 * 按策略端口与会话角色计算可订阅频道。
 * 候选频道取自公共契约枚举，逐个频道询问 provider；未获准的频道不进入 hello，也不能订阅。
 */
export function channelsFor(policy: AccessPolicy, auth: AuthContext): StreamChannel[] {
  return streamChannelSchema.options.filter((channel) =>
    auth.roles.some(
      (role) =>
        policy.authorize({
          principalId: auth.principalId,
          role,
          action: "channel",
          channel,
        }).allowed,
    ),
  );
}

/** 读取 Bearer 认证头；缺失或格式不符返回 null。 */
export function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

/** 按令牌认证会话；失败时写入 401 并返回 null，由路由直接结束。 */
export function authenticate(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): HttpSession | null {
  const token = bearer(request);
  const session = token === null ? null : context.hub.authenticate(token);
  if (session === null) {
    sendHttpError(reply, "unauthenticated", "缺少或无效会话");
    return null;
  }
  return session;
}

/**
 * 玩家入口：会话持有的角色中任一角色经策略端口获准 player 动作才放行。
 * 控制台角色不会因同源地址或页面自报身份获得玩家入口。
 */
export function requirePlayer(context: RouteContext, session: HttpSession, reply: FastifyReply): boolean {
  const decisions = session.auth.roles.map((role) =>
    context.options.accessPolicy.authorize({
      principalId: session.auth.principalId,
      role,
      action: "player",
    }),
  );
  const outcome = decisionOutcome(decisions);
  if (outcome.allowed) {
    return true;
  }
  if (outcome.misconfigured) {
    context.reportInternalError(
      "玩家入口裁决未覆盖会话角色",
      new Error(`角色 ${session.auth.roles.join(",")} 不在权限 provider 的配置内`),
    );
  }
  sendHttpError(reply, "forbidden", "当前角色无权访问玩家接口");
  return false;
}

/**
 * 命令入口在调用网关前裁决：同一角色须同时获准玩家入口与命令类型。
 * 被拒请求不进入 authority，因此不写 receipt、不产生事件、不推进世界状态。
 */
export function requireCommand(
  context: RouteContext,
  session: HttpSession,
  commandType: string,
  reply: FastifyReply,
): boolean {
  const principalId = session.auth.principalId;
  const decisions = session.auth.roles.map((role) => ({
    player: context.options.accessPolicy.authorize({ principalId, role, action: "player" }),
    command: context.options.accessPolicy.authorize({
      principalId,
      role,
      action: "command",
      commandType,
    }),
  }));
  const granted = decisions.filter((pair) => pair.player.allowed && pair.command.allowed);
  if (granted.length > 0) {
    return true;
  }
  // 玩家入口已放行却因命令类型被拒，说明是业务拒绝；两者都未放行时才可能是配置漂移。
  const playerOutcome = decisionOutcome(decisions.map((pair) => pair.player));
  if (!playerOutcome.allowed) {
    const commandOutcome = decisionOutcome(decisions.map((pair) => pair.command));
    if (playerOutcome.misconfigured || commandOutcome.misconfigured) {
      context.reportInternalError(
        `命令入口裁决未覆盖会话角色（commandType=${commandType}）`,
        new Error(`角色 ${session.auth.roles.join(",")} 不在权限 provider 的配置内`),
      );
    }
  }
  sendHttpError(reply, "forbidden", "当前角色不能使用该命令");
  return false;
}

/**
 * 控制台入口：X-Active-Role 必须存在、属于该会话持有的角色，并由策略端口按当前角色裁决。
 * 请求头只用于选择会话内角色，不能扩大会话权限；缺失、非法或不匹配统一返回 403。
 */
export function requireConsole(
  context: RouteContext,
  request: FastifyRequest,
  session: HttpSession,
  reply: FastifyReply,
): boolean {
  const header = request.headers["x-active-role"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value.trim().length === 0) {
    sendHttpError(reply, "forbidden", "控制台请求缺少 X-Active-Role");
    return false;
  }
  const parsed = consoleActiveRoleSchema.safeParse(value.trim());
  if (!parsed.success) {
    sendHttpError(reply, "forbidden", "X-Active-Role 不是控制台角色");
    return false;
  }
  if (!session.auth.roles.includes(parsed.data)) {
    sendHttpError(reply, "forbidden", "当前会话不持有请求的角色");
    return false;
  }
  const decision = context.options.accessPolicy.authorize({
    principalId: session.auth.principalId,
    role: parsed.data,
    action: "console",
  });
  if (!decision.allowed) {
    // 会话确实持有该角色却拿到 unknown-role：provider 的 consoleRoles 没有覆盖它。
    if (decision.reason === "unknown-role") {
      context.reportInternalError(
        `控制台入口裁决未覆盖会话角色（role=${parsed.data}）`,
        new Error(`角色 ${parsed.data} 不在权限 provider 的配置内`),
      );
    }
    sendHttpError(reply, "forbidden", "当前角色无权访问控制台接口");
    return false;
  }
  return true;
}

/** 在通用控制台入口校验之外，再限制页面允许的角色范围。 */
export function requireConsoleRole(
  context: RouteContext,
  request: FastifyRequest,
  session: HttpSession,
  reply: FastifyReply,
  allowedRoles: readonly string[],
): boolean {
  if (!requireConsole(context, request, session, reply)) {
    return false;
  }
  const header = request.headers["x-active-role"];
  const role = Array.isArray(header) ? header[0] : header;
  if (typeof role !== "string" || !allowedRoles.includes(role.trim())) {
    sendHttpError(reply, "forbidden", "当前控制台角色无权访问该页面接口");
    return false;
  }
  return true;
}

/** 控制台装配握手：会话持有的任一角色获准 console-session 动作即可读取。 */
export function isConsoleSession(context: RouteContext, session: HttpSession): boolean {
  return session.auth.roles.some(
    (role) =>
      context.options.accessPolicy.authorize({
        principalId: session.auth.principalId,
        role,
        action: "console-session",
      }).allowed,
  );
}

/** 会话分页未指定 limit 时取投影同样的窗口；上限由公共 schema 固定为 100。 */
export const defaultConversationLimit = 50;

/** 解析会话分页查询；只接受非负整数，非法值返回 null 由路由按 400 处理。 */
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
export function conversationQueryOf(query: unknown): ConversationQuery | null {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return null;
  }
  const record = query as { readonly beforeSeq?: unknown; readonly limit?: unknown };
  const numberValue = (value: unknown): number | undefined | null => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  };
  const beforeSeq = numberValue(record.beforeSeq);
  const limit = numberValue(record.limit);
  if (beforeSeq === null || limit === null) {
    return null;
  }
  const parsed = conversationQuerySchema.safeParse({
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(limit === undefined ? {} : { limit }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 读取玩家与指定主体最近一次交换所在的会话。
 * 只选择双方共同参与且由最近一次提交确定的会话，再按 seq 游标与送达 tick 裁剪对白；
 * 找不到共同会话时返回 null，由路由按资源不存在处理。
 */
export function readPlayerConversation(
  port: ConversationReadPort,
  query: ConversationReadQuery,
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
): ConversationResponse | null {
  const ownConversations = new Set(port.conversationsOf(query.principalId));
  const tick = port.worldTick();
  const loaded = new Map<string, {
    readonly lines: readonly ConversationSourceLine[];
    readonly exhausted: boolean;
  }>();
  const conversationWindow = (conversationId: string, requested: number): readonly ConversationSourceLine[] => {
    const cached = loaded.get(conversationId);
    if (cached !== undefined && (cached.exhausted || cached.lines.length >= requested)) {
      return cached.lines;
    }
    const lines = port.conversationMessages(conversationId, requested);
    loaded.set(conversationId, {
      lines,
      exhausted: lines.length < requested,
    });
    return lines;
  };
  const latestDelivered = (conversationId: string): ConversationSourceLine | null => {
    let window = 20;
    for (;;) {
      const lines = conversationWindow(conversationId, window);
      const line = [...lines].reverse().find((candidate) => {
        const delivery = candidate.deliveries.find(
          (entry) => entry.principalId === query.principalId,
        );
        return delivery !== undefined && delivery.deliverAtTick <= tick;
      });
      if (line !== undefined) {
        return line;
      }
      if (lines.length < window) {
        return null;
      }
      window *= 2;
    }
  };
  let selectedConversationId: string | null = null;
  let selectedLastLine: ConversationSourceLine | null = null;
  let fallbackConversationId: string | null = null;
  let fallbackLastLine: ConversationSourceLine | null = null;
  const isNewer = (
    candidate: ConversationSourceLine,
    current: ConversationSourceLine | null,
    candidateConversationId: string,
    currentConversationId: string | null,
  ): boolean =>
    current === null ||
    candidate.worldSeq > current.worldSeq ||
    (candidate.worldSeq === current.worldSeq &&
      candidate.worldTick > current.worldTick) ||
    (candidate.worldSeq === current.worldSeq &&
      candidate.worldTick === current.worldTick &&
      candidateConversationId > (currentConversationId ?? ""));
  for (const conversationId of port.conversationsOf(query.agentId)) {
    if (!ownConversations.has(conversationId)) {
      continue;
    }
    const lastLine = latestDelivered(conversationId);
    const fallbackLine = loaded.get(conversationId)?.lines.at(-1);
    if (
      fallbackLine !== undefined &&
      isNewer(fallbackLine, fallbackLastLine, conversationId, fallbackConversationId)
    ) {
      fallbackConversationId = conversationId;
      fallbackLastLine = fallbackLine;
    }
    if (lastLine !== null && isNewer(lastLine, selectedLastLine, conversationId, selectedConversationId)) {
      selectedConversationId = conversationId;
      selectedLastLine = lastLine;
    }
  }
  if (selectedConversationId === null) {
    selectedConversationId = fallbackConversationId;
    selectedLastLine = fallbackLastLine;
  }
  if (selectedConversationId === null || selectedLastLine === null) {
    return null;
  }
  const selectedTailLine = loaded.get(selectedConversationId)?.lines.at(-1);
  if (selectedTailLine === undefined) {
    throw new Error(`会话 ${selectedConversationId} 的尾行缓存缺失`);
  }
  // 会话排序使用最后一条已送达行，但分页上界必须覆盖整个尾部窗口。
  const total = selectedTailLine.seq + 1;
  const before = query.beforeSeq ?? total;
  // 端口只支持从尾部读取；先按主体与送达时间过滤，再取分页窗口。
  // 尾部可能有尚未送达的对白，逐次扩大窗口直到凑满 limit 或到达会话开头。
  let window = Math.min(total, Math.max(query.limit * 2, 20));
  let lines: ConversationLine[] = [];
  for (;;) {
    lines = [];
    for (const line of conversationWindow(selectedConversationId, window)) {
      if (line.seq >= before) {
        continue;
      }
      const delivery = line.deliveries.find((candidate) => candidate.principalId === query.principalId);
      if (delivery === undefined || delivery.deliverAtTick > tick) {
        continue;
      }
      lines.push({
        seq: line.seq,
        dialogueId: line.dialogueId,
        speakerId: line.speakerId,
        speakerName: port.speakerName(line.speakerId),
        text: line.text,
        worldTick: line.worldTick,
        channel: line.channel,
      });
    }
    if (lines.length >= query.limit || window >= total) {
      break;
    }
    window = Math.min(total, window * 2);
  }
  return { conversationId: selectedConversationId, lines: lines.slice(-query.limit) };
}
