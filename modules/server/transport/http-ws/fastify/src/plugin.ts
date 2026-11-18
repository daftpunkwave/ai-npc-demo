/**
 * 暴露已校验的传输监听配置；Fastify 路由由应用组合根实现。
 * 依赖严格配置；无 I/O。
 * 禁止在此监听端口或放宽 Origin。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { transportConfigSchema, type TransportConfig } from "./definition";

export class TransportPort {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];

  constructor(config: TransportConfig) {
    this.host = config.host;
    this.port = config.port;
    this.allowedOrigins = config.allowedOrigins;
  }
}

export function createTransportModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = transportConfigSchema.parse(input.config);
  return createStatelessModule(input, new TransportPort(config));
}
