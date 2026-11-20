/**
 * 按 Agent profile 创建槽位实例并解析 run 级能力端口。
 * 依赖模块定义、配置 schema、ModuleInstance 生命周期与共享端口映射。
 * 禁止按目录扫描实现、跨槽复用错误实例或忽略 profile 选择。
 */
import type {
  AgentSlot,
  HostServices,
  Json,
  ModuleCreateInput,
  ModuleDefinition,
  ModuleInstance,
} from "@ai-npc/contracts";
import type {
  AgentCompressionPort,
  AgentContextPort,
  AgentDecisionPort,
  AgentToolViewPort,
  MemoryPort,
  PerceptionPort,
} from "@ai-npc/module-sdk";

export interface AgentSlotModules {
  readonly perception: PerceptionPort;
  readonly memory: MemoryPort;
  readonly context: AgentContextPort;
  readonly compression: AgentCompressionPort;
  readonly toolView: AgentToolViewPort;
  readonly decision: AgentDecisionPort;
}

interface RunningAgentModule {
  readonly slot: AgentSlot;
  readonly instance: ModuleInstance;
  readonly port: unknown;
}

const slotCapabilities: Record<AgentSlot, string> = {
  perception: "agent.perception",
  memory: "agent.memory",
  context: "agent.context",
  compression: "agent.compression",
  toolView: "agent.tool-view",
  decision: "agent.decision",
};

/** 临时启动句柄；按 agentId 逆序释放。 */
export class AgentModuleHandle {
  private constructor(
    readonly agentId: string,
    readonly modules: AgentSlotModules,
    private readonly instances: readonly RunningAgentModule[],
  ) {}

  static async create(input: {
    readonly agentId: string;
    readonly host: HostServices;
    readonly signal: AbortSignal;
    readonly worldId: string;
    readonly branchId: string;
    readonly selections: Readonly<Record<AgentSlot, { readonly module: string; readonly config: Json }>>;
    readonly definitions: ReadonlyMap<string, ModuleDefinition>;
    readonly runPorts: Readonly<Record<string, unknown>>;
  }): Promise<AgentModuleHandle> {
    const instances: RunningAgentModule[] = [];
    const ports = new Map<string, unknown>(Object.entries(input.runPorts));
    for (const slot of ["perception", "memory", "context", "compression", "toolView", "decision"] as const) {
      const selection = input.selections[slot];
      const definition = input.definitions.get(selection.module);
      if (definition === undefined) {
        throw new Error(`Agent 槽位 ${slot} 的模块 ${selection.module} 未登记`);
      }
      if (definition.instanceScope !== "agent") {
        throw new Error(`Agent 槽位 ${slot} 的模块 ${selection.module} 不是 agent 作用域`);
      }
      const rawConfig = (
        typeof definition.defaults === "object" &&
        definition.defaults !== null &&
        !Array.isArray(definition.defaults) &&
        typeof selection.config === "object" &&
        selection.config !== null &&
        !Array.isArray(selection.config)
      )
        ? { ...definition.defaults, ...selection.config }
        : selection.config;
      const config = definition.configSchema.parse(rawConfig) as Json;
      const requiredPorts: Record<string, unknown> = {};
      for (const requirement of definition.requires) {
        const port = ports.get(requirement.capability);
        if (port === undefined) {
          throw new Error(`Agent 模块 ${selection.module} 缺少能力 ${requirement.capability}`);
        }
        requiredPorts[requirement.capability] = port;
      }
      const createInput: ModuleCreateInput = {
        moduleId: definition.id,
        realm: "server",
        config,
        scope: {
          worldId: input.worldId,
          branchId: input.branchId,
          agentId: input.agentId,
        },
        ports: requiredPorts,
        host: input.host,
        signal: input.signal,
      };
      const instance = await definition.create(createInput);
      const port = instance.port;
      if (port === undefined) {
        await instance.dispose();
        throw new Error(`Agent 模块 ${selection.module} 未暴露端口`);
      }
      ports.set(slotCapabilities[slot], port);
      instances.push({ slot, instance, port });
    }
    const bySlot = new Map(instances.map((entry) => [entry.slot, entry.port]));
    try {
      for (const entry of instances) {
        await entry.instance.start(input.signal);
      }
    } catch (error) {
      for (const entry of [...instances].reverse()) {
        try {
          await entry.instance.dispose();
        } catch {
          // Preserve the start failure while attempting every cleanup.
        }
      }
      throw error;
    }
    return new AgentModuleHandle(
      input.agentId,
      {
        perception: bySlot.get("perception") as PerceptionPort,
        memory: bySlot.get("memory") as MemoryPort,
        context: bySlot.get("context") as AgentContextPort,
        compression: bySlot.get("compression") as AgentCompressionPort,
        toolView: bySlot.get("toolView") as AgentToolViewPort,
        decision: bySlot.get("decision") as AgentDecisionPort,
      },
      instances,
    );
  }

  async dispose(): Promise<void> {
    let firstError: unknown;
    for (const entry of [...this.instances].reverse()) {
      try {
        await entry.instance.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
