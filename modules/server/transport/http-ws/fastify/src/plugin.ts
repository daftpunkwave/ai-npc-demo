/**
 * 暴露已校验的传输监听配置；Fastify 路由由应用组合根实现。
 * 依赖严格配置；无 I/O。
 * 禁止在此监听端口或放宽 Origin。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import type { FastifyInstance } from "fastify";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { transportConfigSchema, type TransportConfig } from "./definition";
import { createServerApp, type ServerApp, type ServerAppOptions } from "./app";

export class TransportPort {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];

  constructor(config: TransportConfig) {
    this.host = config.host;
    this.port = config.port;
    this.allowedOrigins = config.allowedOrigins;
  }

  /** 按 provider 配置创建 Fastify 应用；Origin 白名单不允许调用方覆盖。 */
  createApp(options: Omit<ServerAppOptions, "allowedOrigins">): Promise<ServerApp> {
    return createServerApp({ ...options, allowedOrigins: this.allowedOrigins });
  }

  /** 按 provider 配置监听；端口占用由 Fastify 抛出。 */
  async listen(app: FastifyInstance): Promise<void> {
    await app.listen({ host: this.host, port: this.port });
  }
}

export function createTransportModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = transportConfigSchema.parse(input.config);
  return createStatelessModule(input, new TransportPort(config));
}
