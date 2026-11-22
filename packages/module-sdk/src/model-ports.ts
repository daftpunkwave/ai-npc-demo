/**
 * 定义模型池、预算账本和单轮模型策略的服务端契约。
 * 模型池绑定不可变路由，宿主为每个工作和用途注入独立的调用句柄。
 * 禁止通过这些端口获取凭据、执行世界命令或更改冻结路由。
 */
import { capabilityIdSchema, DomainError, modelCapabilitiesSchema } from "@ai-npc/contracts";
import type {
  AgentModelCallResult, CapabilityId, DecisionSubmission, Json, MemoryScope, ModelCapabilities, ModelFixture, ModelOutput,
  NormalizedMessage, NormalizedTool, NormalizedToolCall, Purpose,
} from "@ai-npc/contracts";

export interface ModelCallInput {
  readonly system: string;
  readonly messages: readonly NormalizedMessage[];
  readonly tools: readonly NormalizedTool[];
  readonly output: ModelOutput;
  readonly round: number;
  readonly inputLimit: number;
  readonly contextArtifactId?: string;
}

export interface ModelWorkScope extends MemoryScope {
  readonly runId: string;
  readonly workRef: string;
  readonly traceId: string;
  readonly worldTick: number;
  readonly triggerPrincipalIds: readonly string[];
  readonly maxModelCalls: number;
  readonly maxDailyTokens: number;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly fence: () => boolean;
}

export interface ModelRoute {
  readonly agentId: string;
  readonly purpose: Purpose;
  readonly modelId: string;
  readonly externalModel: string;
  readonly connectionId: string;
  readonly adapterId: string;
  readonly endpoint: string | null;
  readonly credentialRef: string | null;
  readonly fixtureRows: readonly ModelFixture[];
  readonly rateLimitKey: string;
  readonly parameters: Json;
  readonly configHash: string;
  readonly capabilities: ModelCapabilities;
  readonly maxConcurrent: number;
  readonly maxOutputTokens: number;
  readonly requestTimeoutMs: number;
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  readonly price: { readonly inputPerMTok: number; readonly outputPerMTok: number; readonly currency: string };
}

export interface ModelRunLimits {
  readonly maxTokens: number | null;
  readonly maxCost: number | null;
}

export interface RunModelPort {
  route(agentId: string, purpose: Purpose): Pick<ModelRoute, "capabilities" | "maxOutputTokens">;
  call(scope: ModelWorkScope, purpose: Purpose, reserveOutputTokens: number, input: ModelCallInput): Promise<AgentModelCallResult>;
}

export interface AgentModelPoolPort {
  bindRun(input: {
    readonly routes: readonly ModelRoute[];
    readonly limits: ModelRunLimits;
    readonly jsonOutputSuffix?: string;
  }): RunModelPort;
}

/** 装配层模型池能力 ID；Agent 实例创建时在该能力键下注入 {@link AgentDecisionModelRoutes} 路由视图，而非池端口本身。 */
export const agentModelPoolCapability: CapabilityId = capabilityIdSchema.parse("agent.model-pool");

/** 模型决策类 Agent 模块运行必需的模型用途权威定义；路由视图构建、模块消费校验与挂载冻结预检共用此列表。 */
export const agentRequiredModelPurposes = ["decision", "speech"] as const;

export type AgentRequiredModelPurpose = (typeof agentRequiredModelPurposes)[number];

/**
 * Agent 实例创建时在模型池能力键下注入的路由视图：按必需用途给出该 Agent 本 run 已解析的路由，
 * 键为模型用途而非策略端口，决策与对白端口各自按用途消费；
 * 路由条目复用 RunModelPort 的查询返回类型，与装配层面向宿主的 AgentModelPoolPort 分离。
 */
export type AgentDecisionModelRoutes = Readonly<Record<AgentRequiredModelPurpose, ReturnType<RunModelPort["route"]>>>;

/** 从已绑定的 run 模型端口构建路由视图；注入方统一经此入口，保证必需用途齐全；新增用途时编译器强制同步此字面量。 */
export function bindAgentModelRoutes(run: RunModelPort, agentId: string): AgentDecisionModelRoutes {
  return {
    decision: run.route(agentId, "decision"),
    speech: run.route(agentId, "speech"),
  };
}

/** 用途级路由能力要求：逐必需用途判断路由能力是否满足消费方端口的需求。 */
export type AgentModelPurposeRequirement = Readonly<
  Record<AgentRequiredModelPurpose, (capabilities: ModelCapabilities) => boolean>
>;

/** 模型决策端口对必需用途的能力要求：决策路由必须支持工具调用，对白路由必须支持结构化输出。 */
export const modelDecisionPurposeRequirements: AgentModelPurposeRequirement = {
  decision: (capabilities) => capabilities.toolCalling === true,
  speech: (capabilities) => capabilities.structuredOutput !== "none",
};

/**
 * 校验模块 ports 表中模型池能力键下注入的原始值，并收窄为路由视图。
 * 视图注入缺失、必需用途缺失、能力声明缺失或不合法、能力不满足端口要求都抛出 assembly-incompatible；
 * 消费方以声明的能力键取值后经此入口校验，替代对注入值的裸类型断言。
 */
export function resolveAgentModelRoutes(input: {
  readonly view: unknown;
  readonly moduleId: string;
  readonly requirements: AgentModelPurposeRequirement;
}): AgentDecisionModelRoutes {
  const view = input.view;
  if (typeof view !== "object" || view === null) {
    throw new DomainError("assembly-incompatible", `Agent 模块 ${input.moduleId} 缺少模型池能力的路由视图注入`);
  }
  const routes = view as Partial<Record<AgentRequiredModelPurpose, unknown>>;
  for (const purpose of agentRequiredModelPurposes) {
    const route = routes[purpose];
    if (typeof route !== "object" || route === null) {
      throw new DomainError("assembly-incompatible", `Agent 模块 ${input.moduleId} 的路由视图缺少必需的 ${purpose} 用途`);
    }
    const capabilities = modelCapabilitiesSchema.safeParse((route as { readonly capabilities?: unknown }).capabilities);
    if (!capabilities.success) {
      throw new DomainError("assembly-incompatible", `Agent 模块 ${input.moduleId} 的 ${purpose} 模型路由能力声明缺失或不合法`);
    }
    if (!input.requirements[purpose](capabilities.data)) {
      throw new DomainError("assembly-incompatible", `Agent 模块 ${input.moduleId} 的 ${purpose} 模型路由不满足端口能力要求`);
    }
  }
  return view as AgentDecisionModelRoutes;
}

export interface ModelBudgetReservation {
  readonly scope: ModelWorkScope;
  readonly limits: ModelRunLimits;
  readonly route: ModelRoute;
  readonly reservedInput: number;
  readonly reservedOutput: number;
}

export interface AgentBudgetPort {
  check(input: ModelBudgetReservation): void;
  reserve(input: ModelBudgetReservation & { readonly entryId: string }): void;
  settle(input: {
    readonly entryId: string;
    readonly actualInput: number | null;
    readonly actualOutput: number | null;
    readonly sent: boolean;
    readonly price: ModelRoute["price"];
  }): void;
}

export type DecisionValidation = { readonly decision: DecisionSubmission } | { readonly reasons: readonly string[] };

export interface ModelDecisionPort {
  decide(input: {
    readonly system: string;
    readonly user: string;
    readonly tools: readonly NormalizedTool[];
    readonly inputLimit: number;
    readonly firstInputLimit: number;
    readonly toolViewLimits: ReadonlyMap<string, number>;
    readonly maxRounds: number;
    readonly maxCallsPerRound: number;
    readonly maxCallsPerTurn: number;
    readonly nudgeSubmit: string;
    readonly budgetStop: string;
    readonly call: (input: ModelCallInput) => Promise<AgentModelCallResult>;
    readonly executeTool: (call: NormalizedToolCall, round: number) => Promise<{ readonly modelText: string; readonly isError: boolean }>;
    readonly validate: (candidate: Json) => DecisionValidation;
  }): Promise<{
    readonly status: "ok" | "invalid-decision" | "model-failed" | "budget-exhausted" | "over-budget";
    readonly decision: DecisionSubmission | null;
    /** 非 ok 终态的细分原因：round-limit、call-budget、context-window、deadline-backpressure；无细分时为 null。 */
    readonly reason: string | null;
    readonly messages: readonly NormalizedMessage[];
  }>;
  speak(input: {
    readonly request: { readonly system: string; readonly user: string; readonly output: ModelOutput };
    readonly inputLimit: number;
    readonly round: number;
    readonly call: (input: ModelCallInput) => Promise<AgentModelCallResult>;
  }): Promise<Json>;
}

/**
 * 模型尝试经观测端口写入的 span 输入，标识字段允许为空以覆盖非 Agent 场景；
 * 与 turn 阶段的 TurnSpan 是结构对齐的独立声明，二者最终都映射到同一 trace_spans 写入边界。
 */
export interface RunSpan {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly runId: string | null;
  readonly branchId: string | null;
  readonly agentId: string | null;
  readonly turnId: string | null;
  readonly moduleId: string | null;
  readonly moduleVersion: string | null;
  readonly name: string;
  readonly status: "ok" | "error" | "skipped";
  readonly startMs: number;
  readonly endMs: number | null;
  readonly attrs: Json;
}

export interface ModelObservabilityPort {
  recordSpan(span: RunSpan): void;
}
