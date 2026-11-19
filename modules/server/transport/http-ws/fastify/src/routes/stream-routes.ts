/**
 * 注册流路由：签发一次性 WS 票据与建立 WS 连接。
 * 依赖认证会话、流中心的票据签发与握手校验；频道准入在订阅时另行裁决。
 * 禁止在传输层复用登录令牌握手、接受未消费票据或在握手处放宽 Origin 校验。
 */
import type { StreamSocket } from "../stream-hub";
import { authenticate } from "./context";
import type { RouteContext } from "./context";

export function registerStreamRoutes(context: RouteContext): void {
  const { app, hub } = context;

  // 票据与控制台共用：全部已认证会话都可以申请；可订阅频道在握手与订阅时另行裁决。
  app.post("/api/v1/streams/ticket", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    const ticket = hub.issueTicket(session.sessionId);
    return { ticket: ticket.ticket, expiresAt: new Date(ticket.expiresAt).toISOString() };
  });

  app.get("/api/v1/streams", { websocket: true }, (socket, request) => {
    const query = request.query as { readonly ticket?: string };
    const ticketValue = typeof query.ticket === "string" ? query.ticket : undefined;
    // 票据一次性使用与握手校验都由流中心完成；失败以 4401 关闭连接。
    hub.accept(socket as unknown as StreamSocket, ticketValue);
  });
}
