/**
 * 暴露已校验的传输监听配置；Fastify 路由由应用组合根实现。
 * 依赖严格配置与最小应用接口；宿主只经本端口监听与关闭，不接触具体框架类型。
 * 禁止在此放宽 Origin、绕过最小接口直接操作框架实例或让宿主依赖 Fastify。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
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

  /** 按 provider 配置创建应用；Origin 白名单不允许调用方覆盖。 */
  createApp(options: Omit<ServerAppOptions, "allowedOrigins">): Promise<ServerApp> {
    return createServerApp({ ...options, allowedOrigins: this.allowedOrigins });
  }

  /** 按 provider 配置监听；端口占用由传输实现抛出。 */
  async listen(app: ServerApp): Promise<void> {
    await app.listen({ host: this.host, port: this.port });
  }

  /** 停止接受新请求，让关闭编排的排空边界不被新工作突破。 */
  stopAccepting(app: ServerApp): void {
    app.stopAccepting();
  }

  /** 关闭应用；宿主只经本端口触发，不直接依赖框架的关闭语义。 */
  async close(app: ServerApp): Promise<void> {
    await app.close();
  }
}

export function createTransportModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = transportConfigSchema.parse(input.config);
  return createStatelessModule(input, new TransportPort(config));
}
