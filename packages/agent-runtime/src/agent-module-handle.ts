/**
 * 按解析后的 profile 管理单个 Agent 槽位实例。
 * 使用已登记描述符、模块配置与注入的能力端口，失败时释放已创建实例。
 * 不跨身份共享实例，不从实现目录动态发现模块。
 */
import type {
  HostServices,
  Json,
  ModuleCreateInput,
  ModuleDefinition,
  ModuleInstance,
} from "@ai-npc/contracts";
import { resolveModuleConfig } from "@ai-npc/kernel";

export class AgentModuleHandle<Port> {
  private constructor(
    readonly moduleId: string,
    readonly port: Port,
    private readonly instance: ModuleInstance,
  ) {}

  static async create<Port>(input: {
    readonly agentId: string;
    readonly moduleId: string;
    readonly config: Json;
    readonly definition: ModuleDefinition;
    readonly worldId: string;
    readonly branchId: string;
    readonly host: HostServices;
    readonly signal: AbortSignal;
    readonly ports?: Readonly<Record<string, unknown>>;
  }): Promise<AgentModuleHandle<Port>> {
    if (input.definition.instanceScope !== "agent") {
      throw new Error(`Module ${input.moduleId} is not agent-scoped`);
    }
    const ports: Record<string, unknown> = {};
    for (const required of input.definition.requires) {
      const port = input.ports?.[required.capability];
      if (port === undefined) throw new Error(`Agent module ${input.moduleId} requires ${required.capability}`);
      ports[required.capability] = port;
    }
    const createInput: ModuleCreateInput = {
      moduleId: input.definition.id,
      realm: "server",
      config: resolveModuleConfig(input.definition, input.config),
      scope: {
        worldId: input.worldId,
        branchId: input.branchId,
        agentId: input.agentId,
      },
      ports,
      host: input.host,
      signal: input.signal,
    };
    const instance = await input.definition.create(createInput);
    if (instance.port === undefined) {
      await instance.dispose();
      throw new Error(`Agent module ${input.moduleId} did not expose a port`);
    }
    try {
      await instance.start(input.signal);
    } catch (error) {
      try {
        await instance.dispose();
      } catch (cleanupError) {
        input.host.logger.error("Agent module cleanup failed", {
          moduleId: input.moduleId,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }
    return new AgentModuleHandle(input.moduleId, instance.port as Port, instance);
  }

  dispose(): Promise<void> {
    return this.instance.dispose();
  }
}
