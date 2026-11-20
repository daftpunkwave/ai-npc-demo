/**
 * 创建并持有单个 agent 作用域的 MemoryPort 实例。
 * Creates and owns one agent-scoped MemoryPort instance.
 * Depends on the registered module descriptor and injected host services.
 * Must not share mutable state across agents or scan implementation directories.
 */
import type {
  HostServices,
  Json,
  ModuleCreateInput,
  ModuleDefinition,
  ModuleInstance,
} from "@ai-npc/contracts";
import type { MemoryPort } from "@ai-npc/module-sdk";

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

export class MemoryModuleHandle {
  private constructor(
    readonly moduleId: string,
    readonly port: MemoryPort,
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
  }): Promise<MemoryModuleHandle> {
    if (input.definition.instanceScope !== "agent") {
      throw new Error(`Memory module ${input.moduleId} is not agent-scoped`);
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
      throw new Error(`Memory module ${input.moduleId} did not expose a MemoryPort`);
    }
    await instance.start(input.signal);
    return new MemoryModuleHandle(input.moduleId, instance.port as MemoryPort, instance);
  }

  dispose(): Promise<void> {
    return this.instance.dispose();
  }
}
