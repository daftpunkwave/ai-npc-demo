/**
 * 定义 Agent 槽位与宿主运行时之间的 typed ports。
 * 依赖公共契约的 trigger、turn、memory、context、tool、model 与决策结构。
 * 禁止在此实现存储、调度、网络调用或复制第二套 turn loop。
 */
/* eslint-disable no-unused-vars -- 接口方法参数名用于表达调用契约。 */
import type {
  AgentObservation,
  AgentStageEffective,
  AgentTrigger,
  ContextArtifact,
  ContextBuildRequest,
  DecisionSubmission,
  Json,
  MaintenanceTask,
  MemoryBundle,
  MemoryChangePlan,
  AgentMemoryQuery,
  NormalizedMessage,
  ToolBinding,
  ToolDefinition,
  ToolExecutionResult,
  TaskType,
  WakeupProposal,
} from "@ai-npc/contracts";
import type { MemoryScope } from "@ai-npc/contracts";
import type { DelegationView } from "./game-ports";
import type { AgentDecisionStatus } from "./model-ports";
import type { ScopedModelPort } from "./ports";

/** 感知策略对单个已提交事件、单个主体给出的结果。 */
export interface PerceptionRequest {
  readonly scope: MemoryScope;
  readonly event: {
    readonly eventId: string;
    readonly worldSeq: number;
    readonly worldTick: number;
    readonly type: string;
    readonly principalId: string;
    readonly causationIds: readonly string[];
    readonly audience: readonly Json[];
    readonly payload: Json;
  };
  readonly observer: {
    readonly nodeId: string | null;
    readonly factionId: string | null;
    readonly eligible: boolean;
    readonly selfNodeIds: readonly string[];
  };
  readonly rendered: {
    readonly full: {
      readonly summaryZh: string;
      readonly subjectIds: readonly string[];
      readonly nodeId: string | null;
      readonly refs: Readonly<Record<string, string>>;
      readonly facts: Json;
      readonly claim: { readonly sourceId: string; readonly senderId: string; readonly text: string } | null;
    };
    readonly summary: {
      readonly summaryZh: string;
      readonly subjectIds: readonly string[];
      readonly nodeId: string | null;
      readonly refs: Readonly<Record<string, string>>;
      readonly facts: Json;
      readonly claim: { readonly sourceId: string; readonly senderId: string; readonly text: string } | null;
    };
    readonly releasePolicyId: string;
    readonly knownAtTick: number;
  };
  readonly nowTick: number;
}

export interface PerceptionResult {
  readonly observations: readonly AgentObservation[];
  readonly triggers: readonly NewAgentTrigger[];
  readonly scannedThroughSeq: number;
}

export interface NewAgentTrigger {
  readonly kind: AgentTrigger["kind"];
  readonly priority: number;
  readonly sourceRef: string;
  readonly createdTick: number;
  readonly dedupeKey: string;
}

/** 感知槽位端口；不负责调度或 memory 写入。 */
export interface PerceptionPort {
  perceive(input: PerceptionRequest): PerceptionResult;
}

export interface MemoryRecordView {
  readonly memoryId: string;
  readonly rowVersion: number;
  readonly kind: "episodic" | "relation" | "belief" | "prospective" | "core" | "public";
  readonly tier: "short" | "long" | "core" | "none";
  readonly status: "active" | "superseded" | "expired" | "evicted" | "retracted";
  readonly epistemic: "verified-event" | "reported-claim" | "inference";
  readonly releasePolicyId: string;
  readonly validFromTick: number;
  readonly validUntilTick: number | null;
  readonly strength: number;
  readonly salience: number;
  readonly recallCount: number;
  readonly lastReinforcedTick: number;
  readonly tags: readonly string[];
  readonly sourceObservationIds: readonly string[];
  readonly content: {
    readonly summaryZh: string;
    readonly counterpartIds: readonly string[];
    readonly data: Json;
  };
}

/** 宿主提供的身份上下文；记忆策略使用该结构时不暴露内容包。 */
export interface MemoryAgentIdentity {
  readonly factionId: string;
  readonly values: readonly string[];
  readonly initialRelations: readonly {
    readonly targetId: string;
    readonly trust: number;
  }[];
  readonly personalityKeywords: Readonly<Record<
    "agreement" | "rescue" | "resource" | "road" | "evidence",
    readonly string[]
  >>;
}

export interface RevisionView {
  readonly scope: MemoryScope;
  readonly revision: number;
  readonly identity: MemoryAgentIdentity;
  readonly records: readonly MemoryRecordView[];
}

export interface MemoryIngestInput {
  readonly scope: MemoryScope;
  readonly baseRevision: number;
  readonly observations: readonly AgentObservation[];
  readonly worldTick: number;
}

export interface MemoryRecordUseInput {
  readonly scope: MemoryScope;
  readonly baseRevision: number;
  /** 本 turn 的 ID；新建插入行必须以 `sourceTurnId` 回填该值，供宿主校验来源。 */
  readonly turnId: string;
  readonly citedMemoryIds: readonly string[];
  readonly noteworthy: readonly {
    readonly kind: "promise-by-other" | "promise-by-me" | "claim" | "request";
    readonly aboutId: string;
    readonly summary: string;
    readonly dueTick: number | null;
    readonly sourceRefs: readonly string[];
  }[];
  readonly inputObservations: readonly AgentObservation[];
  readonly worldTick: number;
}

export interface MemoryPort {
  prepareIngest(input: MemoryIngestInput, view: RevisionView): MemoryChangePlan;
  retrieve(query: AgentMemoryQuery, view: RevisionView): MemoryBundle;
  planMaintenance(input: {
    readonly scope: MemoryScope;
    readonly revision: number;
    readonly worldTick: number;
    readonly observationSeqThrough: number;
    readonly trigger: "day-passed" | "importance";
  }): MaintenanceTask | null;
  runMaintenance(task: MaintenanceTask, view: RevisionView, model: ScopedModelPort | null): Promise<MemoryChangePlan>;
  recordUse(input: MemoryRecordUseInput, view: RevisionView): MemoryChangePlan;
  proposeWakeups(input: {
    readonly scope: MemoryScope;
    readonly revision: number;
    readonly worldTick: number;
  }, view: RevisionView): readonly WakeupProposal[];
}

/** context 槽位只组装材料，不读取数据库或模型。 */
export interface AgentContextPort {
  build(input: ContextBuildRequest): Promise<ContextArtifact>;
}

/** 压缩结果保留来源与损失报告。 */
export interface AgentCompressionResult {
  readonly status: "not-triggered" | "compressed" | "cannot-fit";
  readonly system: string;
  readonly segments: ContextArtifact["segments"];
  readonly lossReport: Json;
}

export interface AgentCompressionPort {
  compress(input: {
    readonly artifact: ContextArtifact;
    readonly effectiveMaxTokens: number;
    readonly targetTokens: number;
  }): AgentCompressionResult;
}

export interface AgentToolViewPort {
  render(input: {
    readonly phase: "decision" | "speech";
    readonly audience: readonly string[];
    readonly result: ToolExecutionResult;
    readonly viewFields: readonly string[];
    readonly maxListItems: number;
    readonly maxTokens: number;
  }): { readonly text: string; readonly omittedFields: readonly string[]; readonly tokenEstimate: number };
}

export interface AgentToolsPort {
  bindAgentToolset(input: {
    readonly agentId: string;
    readonly toolsetId: string;
    readonly tools: readonly {
      readonly toolId: string;
      readonly version: string;
      readonly permissionProfile: string;
      readonly budgetProfile: "query" | "command";
      readonly viewConstraints: { readonly maxListItems: number; readonly maxTokens: number };
    }[];
  }): void;
  definitions(): readonly ToolDefinition[];
  bindingsFor(agentId: string): readonly ToolBinding[];
  definition(toolId: string, version: string): ToolDefinition | null;
  resolveCommand(input: {
    readonly toolId: string;
    readonly arguments: Json;
  }): { readonly commandType: string; readonly payload: Json } | { readonly error: string };
}

export interface SchedulingInput {
  readonly branchId: string;
  readonly worldTick: number;
  readonly paused: boolean;
  readonly agents: readonly {
    readonly agentId: string;
    readonly active: boolean;
    readonly controllerKind: "agent" | "human";
    readonly strategic: boolean;
  }[];
  readonly triggers: readonly AgentTrigger[];
  readonly runningTurnAgentIds: readonly string[];
  readonly lastTurnTickByAgent: Readonly<Record<string, number>>;
}

export interface SchedulingPort {
  plan(input: SchedulingInput): readonly {
    readonly agentId: string;
    readonly triggerIds: readonly string[];
    readonly score: number;
  }[];
}

/** 决策只使用当前 turn 已授权、冻结的材料与宿主提供的工具执行入口。 */
export interface AgentDecisionInput {
  readonly session: MemoryScope;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly frontier: import("@ai-npc/contracts").InputFrontier;
  readonly profileHash: string;
  readonly templateVersion: string;
  readonly agentTurnIndex: number;
  readonly triggers: readonly AgentTrigger[];
  readonly observations: readonly AgentObservation[];
  readonly memory: MemoryBundle;
  readonly identity: {
    readonly name: string;
    readonly kind: "character" | "strategic";
    readonly factionName: string;
    readonly role: string;
    readonly values: readonly string[];
    readonly skills: readonly string[];
    readonly speechStyle: string;
    readonly bottomLines: readonly string[];
    readonly goals: readonly string[];
  };
  readonly worldViewText: string;
  readonly affairsText: string;
  readonly historyText: string;
  readonly inputText: string;
  readonly system: string;
  readonly loreSummary: string;
  readonly modelWindowTokens: number;
  readonly contextBudget: ContextBuildRequest["budget"];
  readonly model: ScopedModelPort | null;
  readonly context: AgentContextPort;
  readonly compression: AgentCompressionPort;
  readonly tools: AgentToolsPort;
  readonly toolView: AgentToolViewPort;
  readonly executeTool: (input: {
    readonly toolId: string;
    readonly arguments: Json;
    readonly providerCallId: string;
    readonly attemptId: string;
    readonly round: number;
  }) => Promise<{ readonly result: ToolExecutionResult; readonly modelText: string }>;
  readonly maxDecisionRounds: number;
  readonly maxToolCallsPerRound: number;
  readonly maxToolCallsPerTurn: number;
  readonly maxModelCallsPerTurn: number;
  readonly deadlineMs: number;
}

export interface DeterministicDecisionInput extends Pick<AgentDecisionInput,
  "session" | "runId" | "turnId" | "attemptId" | "frontier" | "profileHash" | "agentTurnIndex" |
  "triggers" | "observations" | "memory" | "executeTool" | "deadlineMs"
> {
  readonly runSeed: string;
  readonly self: {
    readonly injured: boolean;
    readonly skills: readonly string[];
    readonly delegations: readonly DelegationView[];
  };
  readonly taskInvitations: readonly {
    readonly taskId: string;
    readonly dispatcherId: string;
    readonly highRiskRoute: boolean;
  }[];
  readonly prospective: readonly {
    readonly memoryId: string;
    readonly counterpartId: string;
    readonly obligorId: string;
    readonly dueTick: number;
    readonly subjectRef: string | null;
  }[];
  readonly lexicons: {
    readonly taskKeywords: readonly { readonly taskType: TaskType | "generic"; readonly word: string }[];
    readonly questionMarkers: readonly string[];
  };
}

export interface AgentDecisionResult {
  readonly status: AgentDecisionStatus;
  readonly decision: DecisionSubmission | null;
  readonly stages: readonly AgentStageEffective[];
  readonly reason: string | null;
  readonly contextArtifacts: readonly ContextArtifact[];
  readonly toolResults: readonly ToolExecutionResult[];
  readonly messages: readonly NormalizedMessage[];
}

export interface AgentSpeechInput extends AgentDecisionInput {
  readonly decision: DecisionSubmission;
  readonly decisionArtifacts: readonly ContextArtifact[];
  readonly receiptsText: string;
}

export interface AgentDecisionPort<Input = AgentDecisionInput> {
  decide(input: Input): Promise<AgentDecisionResult>;
  speak?(input: AgentSpeechInput): Promise<{
    readonly text: string;
    readonly citedRefs: readonly string[];
    readonly fallback: boolean;
    readonly validation: Json;
  }>;
}
