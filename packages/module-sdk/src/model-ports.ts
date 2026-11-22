/**
 * 定义模型池、预算账本和单轮模型策略的服务端契约。
 * 模型池绑定不可变路由，宿主为每个工作和用途注入独立的调用句柄。
 * 禁止通过这些端口获取凭据、执行世界命令或更改冻结路由。
 */
import type {
  AgentModelCallResult, DecisionSubmission, Json, MemoryScope, ModelCapabilities, ModelFixture, ModelOutput,
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

export type AgentDecisionModelRoutes = Readonly<Record<"decision" | "speech", ReturnType<RunModelPort["route"]>>>;

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
    readonly messages: readonly NormalizedMessage[];
  }>;
  speak(input: {
    readonly request: { readonly system: string; readonly user: string; readonly output: ModelOutput };
    readonly inputLimit: number;
    readonly round: number;
    readonly call: (input: ModelCallInput) => Promise<AgentModelCallResult>;
  }): Promise<Json>;
}

/** 模型尝试与 turn 阶段共用的观测输入。 */
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
