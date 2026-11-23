/**
 * 注册玩家读接口与命令路由：提交命令、读取回执、世界投影、战役与开局选项、会话对白。
 * 依赖认证会话、权限端口、命令网关、回执只读端口、投影与会话读取端口。
 * 禁止信任请求自报主体、直接查询存储或把业务拒绝包装成 HTTP 错误。
 */
import {
  campaignResponseSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  conversationResponseSchema,
} from "@ai-npc/contracts";
import {
  authenticate,
  conversationQueryOf,
  defaultConversationLimit,
  readPlayerConversation,
  requireCommand,
  requirePlayer,
  sendHttpError,
} from "./context";
import type { RouteContext } from "./context";

export function registerPlayerRoutes(context: RouteContext): void {
  const { app, hub, options } = context;

  app.post("/api/v1/commands", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
      return;
    }
    const envelope = commandEnvelopeSchema.safeParse(request.body);
    if (!envelope.success) {
      return sendHttpError(reply, "validation", "命令信封结构不合法");
    }
    if (!requireCommand(context, session, envelope.data.type, reply)) {
      return;
    }
    const receipt = commandReceiptSchema.parse(options.authority.commands.execute(session.auth, envelope.data));
    hub.publishWithResync(context.reportInternalError);
    return receipt;
  });

  app.get("/api/v1/commands/:commandId", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
      return;
    }
    const params = request.params as { readonly commandId: string };
    // 主体与分支取自认证会话；传输层只经注入的只读端口取回执，不访问存储表。
    const receipt = options.receipts.read(session.auth.principalId, session.auth.branchId, params.commandId);
    if (receipt === null) {
      return sendHttpError(reply, "not-found", "回执不存在");
    }
    return receipt;
  });

  app.get("/api/v1/world/view", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
      return;
    }
    const state = hub.streamState();
    return { streamSeq: state.streamSeq, projectionVersion: state.projectionVersion, projection: options.projection() };
  });

  app.get("/api/v1/campaign", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
      return;
    }
    // 开局前 campaign 为 null，只返回可选开局；不因缺少 campaign 返回 404。
    // 优先走轻量战役读取端口，未接线时回退完整投影。
    return campaignResponseSchema.parse({
      campaign: options.campaign !== undefined ? options.campaign() : options.projection().campaign,
      starts: [...(options.starts?.() ?? [])],
    });
  });

  app.get("/api/v1/conversations/:agentId", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    if (!requirePlayer(context, session, reply)) {
      return;
    }
    const port = options.conversation;
    if (port === undefined) {
      return sendHttpError(reply, "not-ready", "会话读取尚未就绪");
    }
    const params = request.params as { readonly agentId?: string };
    const agentId = params.agentId ?? "";
    if (agentId.length === 0) {
      return sendHttpError(reply, "not-found", "会话不存在");
    }
    const query = conversationQueryOf(request.query);
    if (query === null) {
      return sendHttpError(reply, "validation", "分页参数不合法");
    }
    const conversation = readPlayerConversation(port, {
      principalId: session.auth.principalId,
      agentId,
      beforeSeq: query.beforeSeq ?? null,
      limit: query.limit ?? defaultConversationLimit,
    });
    if (conversation === null) {
      return sendHttpError(reply, "not-found", "会话不存在");
    }
    return conversationResponseSchema.parse(conversation);
  });
}
