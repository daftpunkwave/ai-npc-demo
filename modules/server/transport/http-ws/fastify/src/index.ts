/**
 * 汇总 HTTP/WS 传输模块的公开入口：定义、配置 schema 与端口类型。
 * 不创建 Fastify 实例、不监听端口。
 */
export const packageName = "@ai-npc/mod-transport-http-ws-fastify";

export { transportConfigSchema, transportModuleDefinition } from "./definition";
export type { TransportConfig } from "./definition";
export { TransportPort } from "./plugin";
export { createServerApp } from "./app";
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
