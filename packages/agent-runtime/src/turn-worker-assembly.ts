/**
 * 核心职责：为每个 Agent 装配 turn 管线所需的模块端口，并按取得顺序登记释放。
 * 交互契约：注入运行时选项、turn 执行选项与运行时停止信号；装配结果按 agentId 取用，
 * 释放严格逆序，单个模块释放失败不中断其余模块。
 * 约束与禁忌：不执行 turn、不读写业务表，也不在装配失败时留下半登记的可释放句柄。
 */
import {
  agentModelPoolCapability,
  bindAgentModelRoutes,
  type AgentCompressionPort,
  type AgentContextPort,
  type AgentToolViewPort,
  type DeterministicDecisionPort,
  type ModelDecisionPort,
} from "@world-prism/module-sdk";
import type { ResolvedAgentProfile } from "@world-prism/experiment";
import { ModelTurnPorts } from "./model-turn";
import { AgentModuleHandle } from "./agent-module-handle";
import type { AgentRuntimeOptions } from "./runtime";
import type { TurnExecutionOptions } from "./turn-worker";

/** 每 Agent 已装配的 turn 模块端口：model 为模型路径端口组，deterministicDecision 为未挂模型池时的确定性决策端口，二者互斥。 */
export type TurnPorts = { readonly toolView: AgentToolViewPort } & (
  { readonly model: ModelTurnPorts; readonly deterministicDecision: null } |
  { readonly model: null; readonly deterministicDecision: DeterministicDecisionPort }
);

/** 确定性决策端口仅在未挂模型路径的装配下存在；越界访问说明装配与运行时模型配置不一致，显式失败并给出主体上下文。 */
export function deterministicDecisionPort(ports: TurnPorts, agentId: string): DeterministicDecisionPort {
  if (ports.model !== null || ports.deterministicDecision === null) {
    throw new Error(`Deterministic decision port missing for ${agentId}`);
  }
  return ports.deterministicDecision;
}

/** 每个 Agent 的模块端口装配与释放；端口在 turn 执行期间只读。 */
export class TurnSlotAssembly {
  private readonly ports = new Map<string, TurnPorts>();
  private readonly disposables: { dispose(): Promise<void> }[] = [];

  constructor(
    private readonly runtime: AgentRuntimeOptions,
    private readonly execution: TurnExecutionOptions,
    private readonly signal: AbortSignal,
  ) {}

  /** 按 roster 逐个装配；缺少 profile hash 或模型池时立即失败，不留半装配状态。 */
  async start(): Promise<void> {
    for (const agent of this.runtime.roster.agents) {
      const profile = this.requireProfile(agent.agentId);
      if (!this.execution.profileHashes.has(agent.agentId)) throw new Error(`Missing profile hash for ${agent.agentId}`);
      const { agentId } = agent;
      const { slots } = profile;
      const toolView = (await this.createSlot<AgentToolViewPort>(agentId, slots.toolView)).port;
      const definition = this.runtime.moduleDefinitions.get(slots.decision?.module ?? "");
      if (definition?.requires.some(({ capability }) => capability === agentModelPoolCapability)) {
        const pool = this.execution.model;
        if (pool == null) throw new Error(`No scoped model pool for ${agentId}`);
        const decision = (await this.createSlot<ModelDecisionPort>(agentId, slots.decision, {
          ...this.execution.ports,
          [agentModelPoolCapability]: bindAgentModelRoutes(pool, agentId),
        })).port;
        const context = (await this.createSlot<AgentContextPort>(agentId, slots.context)).port;
        const compression = (await this.createSlot<AgentCompressionPort>(agentId, slots.compression)).port;
        this.ports.set(agentId, { deterministicDecision: null, toolView, model: { decision, context, compression } });
      } else {
        const decision = (await this.createSlot<DeterministicDecisionPort>(agentId, slots.decision)).port;
        this.ports.set(agentId, { deterministicDecision: decision, toolView, model: null });
      }
    }
  }

  private async createSlot<Port>(agentId: string, selected: ResolvedAgentProfile["slots"]["decision"], ports = this.execution.ports) {
    const definition = selected === undefined ? undefined : this.runtime.moduleDefinitions.get(selected.module);
    if (selected === undefined || definition === undefined) throw new Error(`Unresolved turn module for ${agentId}`);
    const handle = await AgentModuleHandle.create<Port>({
      ...this.runtime, agentId, moduleId: selected.module, config: selected.config, definition,
      ports, signal: this.signal,
    });
    this.disposables.push(handle);
    return handle;
  }

  /** 解析 Agent 的已冻结 profile；缺失说明装配与 roster 不一致，直接失败。 */
  requireProfile(agentId: string): ResolvedAgentProfile {
    const profile = this.runtime.profiles.get(agentId);
    if (profile === undefined) throw new Error(`Missing Agent profile for ${agentId}`);
    return profile;
  }

  /** 取已装配端口；调用方需先确认 start 已成功。 */
  port(agentId: string): TurnPorts | undefined {
    return this.ports.get(agentId);
  }

  /** 逆序释放已装配模块；只保留首个失败原因并在全部释放后抛出。 */
  async dispose(): Promise<void> {
    let failure: unknown;
    for (const handle of this.disposables.splice(0).reverse()) {
      try {
        await handle.dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }
}
