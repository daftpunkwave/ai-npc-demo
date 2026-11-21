/**
 * 核心职责：注册客户端只读内容端点，返回章节名、时钟刻度与界面文字。
 * 交互契约：依赖认证会话与宿主注入的内容端口；任何已认证会话均可读取，响应受客户端内容 schema 约束。
 * 约束与禁忌：未注入内容端口时返回 not-ready，不返回硬编码文案、默认内容或运营数据。
 */
import { clientContentViewSchema } from "@ai-npc/contracts";
import { authenticate, sendHttpError } from "./context";
import type { RouteContext } from "./context";

export function registerContentRoutes(context: RouteContext): void {
  const { app, options } = context;

  app.get("/api/v1/content", (request, reply) => {
    const session = authenticate(context, request, reply);
    if (session === null) {
      return;
    }
    // 内容只含公开章节名与界面文字，不含秘密；已认证的玩家、运营与研究会话都可读，不另设角色白名单。
    const port = options.content;
    if (port === undefined) {
      return sendHttpError(reply, "not-ready", "内容尚未就绪");
    }
    return clientContentViewSchema.parse(port());
  });
}
