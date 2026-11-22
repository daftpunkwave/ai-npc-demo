/**
 * 核心职责：汇总 HTTP/WS 传输模块的公开入口。
 * 交互契约：导出定义、配置 schema、TransportPort、createServerApp、StreamHub 与相关公开类型。
 * 约束与禁忌：不创建 Fastify 实例、不监听端口。
 */
export const packageName = "@ai-npc/mod-transport-http-ws-fastify";

export { transportConfigSchema, transportModuleDefinition } from "./definition";
export type { TransportConfig } from "./definition";
export { TransportPort } from "./plugin";
export { createServerApp } from "./app";
export { StreamHub } from "./stream-hub";
export type {
  StreamHubOptions,
  StreamIdentity,
  StreamSession,
  StreamSocket,
  StreamState,
  StreamStats,
} from "./stream-hub";
export type {
  AccessAction,
  AccessDecision,
  AccessPolicy,
  AccessRequest,
  AuthorityPort,
  CommandReceiptReadPort,
  ConversationReadPort,
  ConversationReadQuery,
  ConversationSourceLine,
  ServerApp,
  ServerAppInjectMethod,
  ServerAppInjectOptions,
  ServerAppInjectResponse,
  ServerAppOptions,
  ServerIdentity,
} from "./app";
