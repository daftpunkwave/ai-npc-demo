/**
 * 核心职责：声明观测 provider 读取他人数据所用的数据源端口，以及由数据所有者解码后的类型化记录。
 * 交互契约：记录由各表的所有者（authority、agent-runtime、宿主 run 登记与本包的审计/artifact 存储）在其一侧
 *   完成列与 JSON 路径的解码，观测 provider 只依赖这里的字段；同一次 read 回调内的查询共享一个存储快照。
 * 约束与禁忌：只声明类型、不实现查询；读取方不得据此推断表名、列名或 JSON 嵌套；
 *   除调试唤醒外端口不提供写入。
 */
/* eslint-disable no-unused-vars -- 接口方法参数名仅用于表达调用契约。 */
import type { CommandStatus, DebugWakeInput, ExecutionStatus, Json } from "@world-prism/contracts";

export type ObservedSortOrder = "asc" | "desc";

/** 已提交的领域事件；受众与载荷已按 JSON 解码。 */
export interface ObservedDomainEvent {
  readonly worldSeq: number;
  readonly worldTick: number;
  readonly eventId: string;
  readonly type: string;
  readonly principalId: string;
  readonly audience: Json;
  readonly payload: Json;
  readonly correlationId: string;
  readonly committedAt: string;
}

/**
 * 时间线的公共筛选：筛选与 limit 由数据源在查询内完成，保证 limit 是筛选后的真实条数。
 * involving 匹配事件主体，或载荷任一文本值包含该 ID；mentioning 只匹配载荷任一文本值包含该文本。
 */
export interface TimelineFilter {
  readonly branchId: string;
  readonly limit: number;
  readonly order: ObservedSortOrder;
  readonly types?: readonly string[];
  readonly involving?: string;
  readonly mentioning?: string;
}

/** 领域事件时间线查询：只取 afterSeq 之后的事件。 */
export interface DomainEventTimelineQuery extends TimelineFilter {
  readonly afterSeq: number;
}

/** 生命周期审计事件；主体缺省表示系统事件。 */
export interface ObservedLifecycleEvent {
  readonly seq: number;
  readonly type: string;
  readonly subjectId: string | null;
  readonly payload: Json;
  readonly createdAt: string;
}

/** 内联 artifact 的正文文本与所属 run。 */
export interface ObservedArtifactBody {
  readonly runId: string | null;
  readonly body: string;
}

/**
 * Agent 在分支上的运行状态，只含冻结名册登记的 Agent。
 * 激活、控制权、最近 turn 与感知水位来自 agent-runtime；名册种类来自 run 的冻结 manifest；位置来自世界模块。
 */
export interface ObservedAgentState {
  readonly agentId: string;
  readonly rosterKind: string | null;
  readonly activationStatus: string;
  readonly controllerKind: string | null;
  readonly latestTurnStatus: string | null;
  readonly scannedThroughSeq: number | null;
  readonly nodeId: string | null;
}

/** 一次 Agent turn 的执行记录；JSON 字段已解码。 */
export interface ObservedTurnRun {
  readonly turnId: string;
  readonly runId: string;
  readonly branchId: string;
  readonly agentId: string;
  readonly agentTurnIndex: number;
  readonly status: string;
  readonly triggerIds: readonly string[];
  readonly inputFrontier: Json | null;
  readonly memoryRevision: number | null;
  readonly terminalReason: string | null;
  readonly effective: Json | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

/** turn 列表筛选；结果按创建时间倒序，limit 由调用方给出上界。 */
export interface TurnRunFilter {
  readonly worldId?: string;
  readonly runId?: string;
  readonly branchId?: string;
  readonly agentId?: string;
  readonly status?: string;
  readonly limit: number;
}

/** turn 内的一次模型尝试。 */
export interface ObservedModelAttempt {
  readonly attemptId: string;
  readonly purpose: string;
  readonly modelId: string;
  readonly status: string;
  readonly isEffective: boolean;
  readonly requestArtifactId: string | null;
  readonly responseArtifactId: string | null;
  readonly usage: Json;
  readonly error: Json | null;
}

/** turn 内的一次工具调用；commandId 指向命令网关的回执。 */
export interface ObservedToolCall {
  readonly toolCallId: string;
  readonly toolId: string;
  readonly executionStatus: ExecutionStatus | null;
  readonly commandId: string | null;
  readonly rawArtifactId: string | null;
  readonly viewArtifactId: string | null;
  readonly operationId: string | null;
}

/** 调度队列计数：排队含未消费触发与 queued turn，运行中为非终态 turn。 */
export interface ObservedSchedulerQueue {
  readonly queued: number;
  readonly running: number;
}

/** 尚未完成的记忆整理任务。 */
export interface ObservedMaintenanceTask {
  readonly status: "queued" | "leased";
  readonly createdAt: string;
}

/** Agent 记忆水位。 */
export interface ObservedMemoryWatermark {
  readonly revision: number;
  readonly observationSeqConsumed: number;
  readonly derivedThroughTick: number;
}

/** 追加式记忆行的一个版本；可见区间为 [createdRevision, retiredRevision)。 */
export interface ObservedMemoryRecord {
  readonly memoryId: string;
  readonly rowVersion: number;
  readonly kind: string;
  readonly status: string;
  readonly epistemic: string;
  readonly releasePolicyId: string;
  readonly validFromTick: number;
  readonly validUntilTick: number | null;
  readonly createdRevision: number;
  readonly retiredRevision: number | null;
  readonly sourceObservationIds: readonly string[];
  readonly content: Json;
}

/** Agent 的一条观察；作用域由读取方按分支补齐。 */
export interface ObservedObservation {
  readonly observationId: string;
  readonly observationSeq: number;
  readonly sourceEventIds: readonly string[];
  readonly sourceObservationIds: readonly string[];
  readonly occurredAtTick: number;
  readonly sensedAtTick: number;
  readonly knownAtTick: number;
  readonly channel: string;
  readonly epistemic: string;
  readonly confidence: number;
  readonly releasePolicyId: string;
  readonly content: Json;
}

/** 绑定到同一存储快照的只读查询集合；方法只在 read 回调内有效。 */
export interface ObservabilitySourceReader {
  domainEventTimeline(query: DomainEventTimelineQuery): readonly ObservedDomainEvent[];
  /** 分支内 afterSeq 之后的全部领域事件，按 worldSeq 升序。 */
  domainEventsAfter(branchId: string, afterSeq: number): readonly ObservedDomainEvent[];
  /** 分支最新领域事件序号；尚无事件时为 null。 */
  latestWorldSeq(branchId: string): number | null;
  /** 命令回执的受理结果；回执不存在时为 null。 */
  commandStatus(branchId: string, principalId: string, commandId: string): CommandStatus | null;
  lifecycleTimeline(query: TimelineFilter): readonly ObservedLifecycleEvent[];
  /** 分支所属世界；分支不存在时为 null。 */
  branchWorldId(branchId: string): string | null;
  /** 按 agentId 升序。 */
  agentStates(branchId: string): readonly ObservedAgentState[];
  turnRuns(filter: TurnRunFilter): readonly ObservedTurnRun[];
  turnRun(turnId: string): ObservedTurnRun | null;
  /** 每个 turn 关联触发的种类，按触发 ID 升序；没有可解析触发的 turn 不出现。 */
  turnTriggerKinds(turnIds: readonly string[]): ReadonlyMap<string, readonly string[]>;
  /** 每个 turn 的工具调用数；没有调用的 turn 不出现。 */
  turnToolCallCounts(turnIds: readonly string[]): ReadonlyMap<string, number>;
  /** 每个 turn 各次模型尝试的用量；未记录用量的尝试为 null，没有尝试的 turn 不出现。 */
  turnModelUsages(turnIds: readonly string[]): ReadonlyMap<string, readonly Json[]>;
  /** 按创建时间与尝试 ID 升序。 */
  turnModelAttempts(runId: string, turnId: string): readonly ObservedModelAttempt[];
  /** 按创建时间与调用 ID 升序。 */
  turnToolCalls(runId: string, turnId: string): readonly ObservedToolCall[];
  schedulerQueue(branchId: string): ObservedSchedulerQueue;
  /** 分支所属 run 中仍处于 started 的模型尝试创建时间。 */
  startedModelAttemptTimes(branchId: string): readonly string[];
  pendingMaintenance(branchId: string): readonly ObservedMaintenanceTask[];
  memoryWatermark(branchId: string, agentId: string): ObservedMemoryWatermark | null;
  /** 感知状态版本；尚未建立感知状态时为 null。 */
  perceptionRevision(branchId: string, agentId: string): number | null;
  /** 该 Agent 全部记忆行版本，按 memoryId 与 rowVersion 升序。 */
  memoryRecords(branchId: string, agentId: string): readonly ObservedMemoryRecord[];
  /** afterSeq 之后至多 limit 条观察，按 observationSeq 升序。 */
  observations(branchId: string, agentId: string, afterSeq: number, limit: number): readonly ObservedObservation[];
}

/** 观测 provider 的数据源端口：由宿主用各数据所有者的查询组合后注入。 */
export interface ObservabilitySources {
  /** 在一个存储快照内执行一组只读查询。 */
  read<T>(query: (reader: ObservabilitySourceReader) => T): T;
  /**
   * 按 ID 读取 artifact 正文与所属 run；不存在时为 null。
   * 不属于 read 的存储快照：超过内联上限的正文存放在文件中，必须在事务外读取。
   */
  artifactBody(artifactId: string): ObservedArtifactBody | null;
  /**
   * 为 Agent 登记一次调试唤醒：同一事务内写入调试触发、把分支所属 run 标记为受污染并记生命周期审计。
   * 同一分支内以 operationId 幂等；内容不一致的重放以 idempotency-conflict 拒绝。
   */
  requestDebugWake(input: DebugWakeInput): void;
}
