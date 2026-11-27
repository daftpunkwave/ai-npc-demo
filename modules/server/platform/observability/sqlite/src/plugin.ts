/**
 * 核心职责：写入本模块拥有的 trace_spans 跨度，并基于宿主绑定的数据源端口提供时间线、Agent 列表、检查器与研究查询。
 * 交互契约：StoragePort 只用于自有的 trace_spans 与生命周期审计写入；领域事件、审计时间线、Agent 状态、turn 证据等
 *   他人拥有的数据只经 bind 注入的 ObservabilitySources 读取，不感知其表结构；未绑定时这些查询返回 not-ready。
 * 约束与禁忌：禁止在模块内执行模型调用、删除审计记录或返回未授权原文；不改变世界事实或 Agent 记忆。
 */
import {
  DomainError,
  agentInspectorResponseSchema,
  type AgentInspectorResponse,
  type AgentWorldView,
  type ArtifactResponse,
  type AgentsResponse,
  type BranchCompareResponse,
  type DebugQueuesResponse,
  type DebugWakeInput,
  type DebugWakeResponse,
  type HostServices,
  type Json,
  type MemoryDiffResponse,
  type MemoryResponse,
  type ModuleCreateInput,
  type ModuleInstance,
  type ObservationsResponse,
  type StoragePort,
  type TimelineItem,
  type TimelineResponse,
  type TraceResponse,
  type TurnDetail,
  type TurnsResponse,
} from "@world-prism/contracts";
import {
  createStatelessModule,
  type ObservabilitySources,
  type TimelineFilter,
} from "@world-prism/module-sdk";
import { z } from "zod";
import { ResearchQueries } from "./research-queries";

const configSchema = z.object({
  timelineLimit: z.number().int().min(1).max(1_000),
}).strict();

/** trace_spans 表的写入记录；模型尝试的 RunSpan 与 turn 阶段的 TurnSpan 是结构对齐的独立声明，经各自端口映射为该结构落库。 */
export interface SpanRecord {
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

export interface TimelineQuery {
  readonly branchId: string;
  readonly fromSeq: number;
  readonly limit: number;
  readonly order?: "asc" | "desc";
  readonly types?: readonly string[];
  readonly agentId?: string;
  readonly nodeId?: string;
}

export class ObservabilityPort {
  private readonly storage: StoragePort;
  private readonly maxTimelineLimit: number;
  private readonly host: HostServices | undefined;
  private sources: ObservabilitySources | null = null;

  constructor(
    storage: StoragePort,
    config: { readonly timelineLimit: number },
    host?: HostServices,
  ) {
    this.storage = storage;
    this.maxTimelineLimit = config.timelineLimit;
    this.host = host;
  }

  /** 绑定宿主用各数据所有者的查询组合出的数据源端口；跨度写入不依赖它。 */
  bind(sources: ObservabilitySources): void {
    this.sources = sources;
  }

  private requireSources(): ObservabilitySources {
    if (this.sources === null) throw new DomainError("not-ready", "观测数据源尚未绑定");
    return this.sources;
  }

  recordSpan(span: SpanRecord): void {
    this.storage.transact((tx) => {
      tx.rows("trace_spans").put({
        span_id: span.spanId,
        trace_id: span.traceId,
        parent_span_id: span.parentSpanId,
        run_id: span.runId,
        branch_id: span.branchId,
        agent_id: span.agentId,
        turn_id: span.turnId,
        module_id: span.moduleId,
        module_version: span.moduleVersion,
        name: span.name,
        status: span.status,
        start_ms: span.startMs,
        end_ms: span.endMs,
        started_at: this.wallClockStart(span.startMs),
        attrs_json: span.attrs,
      });
    });
  }

  private wallClockStart(startMs: number): string | null {
    if (startMs >= 1_000_000_000_000) return new Date(startMs).toISOString();
    if (this.host === undefined) return null;
    const wallNow = Date.parse(this.host.nowIso());
    const monotonicNow = this.host.monotonicMs();
    const elapsed = Math.max(0, monotonicNow - startMs);
    const startedAt = wallNow - elapsed;
    return Number.isFinite(startedAt) && startedAt >= 0 ? new Date(startedAt).toISOString() : null;
  }

  timeline(query: TimelineQuery): TimelineResponse {
    const limit = Math.min(query.limit, this.maxTimelineLimit);
    const filter: TimelineFilter = {
      branchId: query.branchId,
      limit,
      order: query.order === "desc" ? "desc" : "asc",
      types: query.types,
      involving: query.agentId,
      mentioning: query.nodeId,
    };
    const sourced = this.requireSources().read((reader) => ({
      domain: reader.domainEventTimeline({ ...filter, afterSeq: query.fromSeq }),
      lifecycle: reader.lifecycleTimeline(filter),
    }));
    const domainEvents: TimelineItem[] = sourced.domain.map((event) => ({
      kind: "domain",
      worldSeq: event.worldSeq,
      worldTick: event.worldTick,
      eventId: event.eventId as TimelineItem["eventId"],
      type: event.type,
      principalId: event.principalId as TimelineItem["principalId"],
      audience: event.audience as TimelineItem["audience"],
      summaryZh: `${event.type} · ${event.principalId}`,
      payload: event.payload,
      correlationId: event.correlationId,
      createdAt: event.committedAt,
    }));
    const lifecycleEvents: TimelineItem[] = sourced.lifecycle.map((event) => ({
      kind: "lifecycle",
      worldSeq: null,
      worldTick: null,
      eventId: null,
      type: event.type,
      principalId: event.subjectId as TimelineItem["principalId"],
      audience: null,
      summaryZh: `${event.type} · ${event.subjectId ?? "系统"}`,
      payload: event.payload,
      correlationId: null,
      createdAt: event.createdAt,
    }));
    const directionFactor = query.order === "desc" ? -1 : 1;
    const events = [...domainEvents, ...lifecycleEvents]
      .sort((left, right) => {
        const byTime = left.createdAt.localeCompare(right.createdAt);
        if (byTime !== 0) {
          return byTime * directionFactor;
        }
        return (left.worldSeq ?? -1) - (right.worldSeq ?? -1) === 0
          ? 0
          : ((left.worldSeq ?? -1) - (right.worldSeq ?? -1)) * directionFactor;
      })
      .slice(0, limit);
    return { events };
  }

  agents(branchId: string): AgentsResponse {
    // 位置取自世界模块拥有的角色状态，水位滞后取该 Agent 已感知世界序号与全局最新序号之差：
    // 两者都是已持久化的事实，不再用固定的 null / 0 冒充，避免控制台永远显示「零滞后、位置未知」。
    // 最新序号与 Agent 状态在同一次数据源读取里取得，保证同一响应内的 lag 以同一快照为基准。
    const snapshot = this.requireSources().read((reader) => ({
      latestWorldSeq: reader.latestWorldSeq(branchId),
      agents: reader.agentStates(branchId),
    }));
    const latest = snapshot.latestWorldSeq ?? 0;
    return {
      agents: snapshot.agents.map((agent) => ({
        agentId: agent.agentId as AgentsResponse["agents"][number]["agentId"],
        kind: agent.rosterKind === "character" ? "character" : "strategic",
        active: agent.activationStatus === "active",
        controllerKind: agent.controllerKind === "human" ? "human" : "agent",
        location: agent.nodeId !== null && agent.nodeId.length > 0 ? agent.nodeId : null,
        turnStatus: agent.latestTurnStatus ?? "idle",
        // 尚未建立感知水位的 Agent 视为滞后整条事件流，而不是滞后 0。
        watermarkLag: Math.max(0, latest - (agent.scannedThroughSeq ?? 0)),
      })),
    };
  }

  memory(branchId: string, agentId: string, revision: number): MemoryResponse {
    return this.research().memory(branchId, agentId, revision);
  }

  memoryDiff(branchId: string, agentId: string, from: number, to: number): MemoryDiffResponse {
    return this.research().memoryDiff(branchId, agentId, from, to);
  }

  observations(branchId: string, agentId: string, fromSeq: number, limit: number): ObservationsResponse {
    return this.research().observations(branchId, agentId, fromSeq, limit);
  }

  turns(query: {
    readonly runId?: string;
    readonly branchId?: string;
    readonly worldId?: string;
    readonly agentId?: string;
    readonly status?: string;
    readonly limit?: number;
  }): TurnsResponse {
    return this.research().turns(query);
  }

  turn(turnId: string): TurnDetail {
    return this.research().turn(turnId);
  }

  artifact(artifactId: string, view: "redacted" | "raw", principalId: string): ArtifactResponse {
    return this.research().artifact(artifactId, view, principalId);
  }

  trace(traceId: string): TraceResponse {
    return this.research().trace(traceId);
  }

  branchCompare(left: string, right: string, atSeq: number): BranchCompareResponse {
    return this.research().branchCompare(left, right, atSeq);
  }

  debugQueues(branchId: string): DebugQueuesResponse {
    return this.research().debugQueues(branchId);
  }

  debugWake(input: DebugWakeInput): DebugWakeResponse {
    return this.research().debugWake(input);
  }

  inspector(input: {
    readonly branchId: string;
    readonly agentId: string;
    readonly persona: Json;
    readonly location: string | null;
    readonly worldView: AgentWorldView;
  }): AgentInspectorResponse {
    const state = this.requireSources().read((reader) => ({
      watermark: reader.memoryWatermark(input.branchId, input.agentId),
      perceptionRevision: reader.perceptionRevision(input.branchId, input.agentId),
    }));
    const revision = state.watermark?.revision ?? 0;
    const records = this.memory(input.branchId, input.agentId, revision).records;
    const relations = records.flatMap((record) => {
      if (record.kind !== "relation" || Array.isArray(record.content) ||
        record.content === null || typeof record.content !== "object") return [];
      const counterparts = record.content["counterpartIds"];
      const data = record.content["data"];
      if (!Array.isArray(counterparts) || typeof counterparts[0] !== "string" ||
        data === null || Array.isArray(data) || typeof data !== "object") return [];
      const trust = data["trust"];
      if (typeof trust !== "number" || !Number.isInteger(trust) || trust < -2 || trust > 2) return [];
      return [{
        targetId: counterparts[0] as AgentInspectorResponse["relations"][number]["targetId"],
        label: typeof record.content["summaryZh"] === "string" && record.content["summaryZh"].length > 0
          ? record.content["summaryZh"]
          : record.kind,
        trust,
      }];
    });
    const commitments = records.flatMap((record) => {
      if (record.kind !== "prospective" || Array.isArray(record.content) ||
        record.content === null || typeof record.content !== "object") return [];
      const summary = record.content["summaryZh"];
      const data = record.content["data"];
      if (typeof summary !== "string" || summary.length === 0) return [];
      const dueTick = data !== null && !Array.isArray(data) && typeof data === "object" &&
        typeof data["dueTick"] === "number" && Number.isSafeInteger(data["dueTick"])
        ? data["dueTick"] : null;
      return [{
        kind: "promise" as const,
        refId: record.memoryId,
        summary,
        dueTick,
        state: record.status,
      }];
    });
    const observationSeq = state.watermark?.observationSeqConsumed ?? 0;
    const derivedThroughTick = state.watermark?.derivedThroughTick ?? 0;
    const perceptionRevision = state.perceptionRevision ?? 0;
    return agentInspectorResponseSchema.parse({
      agentId: input.agentId,
      persona: input.persona,
      location: input.location,
      worldView: input.worldView,
      memoryRevision: revision,
      memoryRecords: records,
      relations,
      commitments,
      watermarks: {
        observationSeq,
        perceptionRevision,
        memoryRevision: revision,
        derivedThroughTick,
      },
      recentTurns: this.turns({ agentId: input.agentId, branchId: input.branchId, limit: 20 }).turns,
    });
  }

  private research(): ResearchQueries {
    if (this.host === undefined) throw new DomainError("not-ready", "观测研究查询缺少宿主依赖");
    return new ResearchQueries(this.storage, this.host, this.requireSources());
  }
}

export async function createObservabilityModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const storage = input.ports["platform.storage"];
  if (typeof storage !== "object" || storage === null) {
    throw new DomainError("assembly-incompatible", "观测模块缺少平台存储端口");
  }
  const config = configSchema.parse(input.config);
  return createStatelessModule(input, new ObservabilityPort(storage as StoragePort, config, input.host));
}
