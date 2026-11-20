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

/** 统一非 2xx 载荷：错误码、可重试标记与安全文案；不含内部细节或敏感上下文。 */
export function sendHttpError(
  reply: FastifyReply,
  code: ErrorCode,
  safeMessage: string,
  retryable = false,
): FastifyReply {
  // eslint-disable-next-line security/detect-object-injection -- 错误码是内部 ErrorCode 枚举，索引来自受限字面量联合。
  return reply.code(statusByErrorCode[code]).send(
    errorResponseSchema.parse({
      error: { code, retryable, safeMessage, traceId: null, detailsArtifactRef: null },
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
  const allowed = session.auth.roles.some(
    (role) =>
      context.options.accessPolicy.authorize({
        principalId: session.auth.principalId,
        role,
        action: "player",
      }).allowed,
  );
  if (allowed) {
    return true;
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
  const allowed = session.auth.roles.some((role) => {
    const principalId = session.auth.principalId;
    return (
      context.options.accessPolicy.authorize({ principalId, role, action: "player" }).allowed &&
      context.options.accessPolicy.authorize({
        principalId,
        role,
        action: "command",
        commandType,
      }).allowed
    );
  });
  if (allowed) {
    return true;
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
    sendHttpError(reply, "forbidden", "当前角色无权访问控制台接口");
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
 * 只选择双方共同参与且由最近一次交换确定的会话，再按 seq 游标与送达 tick 裁剪对白；
 * 找不到共同会话时返回 null，由路由按资源不存在处理。
 */
export function readPlayerConversation(
  port: ConversationReadPort,
  query: ConversationReadQuery,
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
): ConversationResponse | null {
  const ownConversations = new Set(port.conversationsOf(query.principalId));
  let selectedConversationId: string | null = null;
  let selectedLastLine: ConversationSourceLine | null = null;
  for (const conversationId of port.conversationsOf(query.agentId)) {
    if (!ownConversations.has(conversationId)) {
      continue;
    }
    const lastLine = port.conversationMessages(conversationId, 1).at(-1);
    if (lastLine === undefined) {
      continue;
    }
    if (
      selectedLastLine === null ||
      lastLine.worldTick > selectedLastLine.worldTick ||
      (lastLine.worldTick === selectedLastLine.worldTick && conversationId > (selectedConversationId ?? ""))
    ) {
      selectedConversationId = conversationId;
      selectedLastLine = lastLine;
    }
  }
  if (selectedConversationId === null || selectedLastLine === null) {
    return null;
  }
  const tick = port.worldTick();
  const total = selectedLastLine.seq + 1;
  const before = query.beforeSeq ?? total;
  // 端口只支持从尾部读取；先按主体与送达时间过滤，再取分页窗口。
  // 尾部可能有尚未送达的对白，逐次扩大窗口直到凑满 limit 或到达会话开头。
  let window = Math.min(total, Math.max(query.limit * 2, 20));
  let lines: ConversationLine[] = [];
  for (;;) {
    lines = [];
    for (const line of port.conversationMessages(selectedConversationId, window)) {
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
