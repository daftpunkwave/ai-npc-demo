/**
 * 按 Agent profile 创建并释放单个感知槽位实例。
 * 依赖模块定义、严格配置 schema 与宿主服务；不加载其他 Agent 槽位。
 * 禁止按目录扫描实现或让感知实例持有跨身份状态。
 */
import type {
  HostServices,
  Json,
  ModuleCreateInput,
  ModuleDefinition,
  ModuleInstance,
} from "@ai-npc/contracts";
import type { PerceptionPort } from "@ai-npc/module-sdk";

function mergedConfig(definition: ModuleDefinition, config: Json): Json {
  if (
    typeof definition.defaults === "object" &&
    definition.defaults !== null &&
    !Array.isArray(definition.defaults) &&
    typeof config === "object" &&
    config !== null &&
    !Array.isArray(config)
  ) {
    return { ...definition.defaults, ...config };
  }
  return config;
}

export class PerceptionModuleHandle {
  private constructor(
    readonly port: PerceptionPort,
    private readonly instance: ModuleInstance,
  ) {}

  static async create(input: {
    readonly agentId: string;
    readonly moduleId: string;
    readonly config: Json;
    readonly definition: ModuleDefinition;
    readonly worldId: string;
    readonly branchId: string;
    readonly host: HostServices;
    readonly signal: AbortSignal;
  }): Promise<PerceptionModuleHandle> {
    if (input.definition.instanceScope !== "agent") {
      throw new Error(`感知模块 ${input.moduleId} 不是 agent 作用域`);
    }
    const createInput: ModuleCreateInput = {
      moduleId: input.definition.id,
      realm: "server",
      config: input.definition.configSchema.parse(
        mergedConfig(input.definition, input.config),
      ) as Json,
      scope: {
        worldId: input.worldId,
        branchId: input.branchId,
        agentId: input.agentId,
      },
      ports: {},
      host: input.host,
      signal: input.signal,
    };
    const instance = await input.definition.create(createInput);
    if (instance.port === undefined) {
      await instance.dispose();
      throw new Error(`感知模块 ${input.moduleId} 未暴露端口`);
    }
    await instance.start(input.signal);
    return new PerceptionModuleHandle(instance.port as PerceptionPort, instance);
  }

  dispose(): Promise<void> {
    return this.instance.dispose();
  }
}
