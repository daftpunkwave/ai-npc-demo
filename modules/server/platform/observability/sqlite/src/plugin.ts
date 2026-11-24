/**
 * 使用固定 trace_spans、domain_events 与生命周期表提供观测写入和只读查询。
 * 依赖注入的 StoragePort、模块生命周期与公共 DTO；不改变世界事实或 Agent 记忆。
 * 禁止在模块内执行模型调用、删除审计记录或返回未授权原文。
 */
import {
  DomainError,
  agentInspectorResponseSchema,
  jsonValueSchema,
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
  type StorageValue,
  type StoragePort,
  type TimelineItem,
  type TimelineResponse,
  type TraceResponse,
  type TurnDetail,
  type TurnsResponse,
} from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
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

  constructor(
    storage: StoragePort,
    config: { readonly timelineLimit: number },
    host?: HostServices,
  ) {
    this.storage = storage;
    this.maxTimelineLimit = config.timelineLimit;
    this.host = host;
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
    const direction = query.order === "desc" ? "DESC" : "ASC";
    const domainConditions = ["branch_id = ?", "world_seq > ?"];
    const domainParameters: StorageValue[] = [query.branchId, query.fromSeq];
    const lifecycleConditions = ["branch_id = ?"];
    const lifecycleParameters: StorageValue[] = [query.branchId];
    if (query.types !== undefined && query.types.length > 0) {
      const placeholders = query.types.map(() => "?").join(", ");
      domainConditions.push(`type IN (${placeholders})`);
      lifecycleConditions.push(`type IN (${placeholders})`);
      domainParameters.push(...query.types);
      lifecycleParameters.push(...query.types);
    }
    if (query.agentId !== undefined) {
      domainConditions.push(
        `(principal_id = ? OR EXISTS (
          SELECT 1 FROM json_tree(payload_json) AS payload_value
          WHERE payload_value.type = 'text'
             AND INSTR(CAST(payload_value.value AS TEXT), ?) > 0
        ))`,
      );
      domainParameters.push(query.agentId, query.agentId);
      lifecycleConditions.push(
        `(subject_id = ? OR EXISTS (
          SELECT 1 FROM json_tree(payload_json) AS payload_value
           WHERE payload_value.type = 'text'
             AND INSTR(CAST(payload_value.value AS TEXT), ?) > 0
        ))`,
      );
      lifecycleParameters.push(query.agentId, query.agentId);
    }
    if (query.nodeId !== undefined) {
      const nodeFilter = `EXISTS (
        SELECT 1 FROM json_tree(payload_json) AS payload_value
         WHERE payload_value.type = 'text'
           AND INSTR(CAST(payload_value.value AS TEXT), ?) > 0
      )`;
      domainConditions.push(nodeFilter);
      lifecycleConditions.push(nodeFilter);
      domainParameters.push(query.nodeId);
      lifecycleParameters.push(query.nodeId);
    }
    domainParameters.push(limit);
    lifecycleParameters.push(limit);
    const rows = this.storage.transact((tx) =>
      tx.all(
        `SELECT world_seq, world_tick, event_id, type, principal_id, audience_json,
                payload_json, correlation_id, committed_at
           FROM domain_events
          WHERE ${domainConditions.join(" AND ")}
          ORDER BY world_seq ${direction}
          LIMIT ?`,
        domainParameters,
      ),
    );
    const domainEvents: TimelineItem[] = rows.map((row) => {
      const type = String(row["type"]);
      const payload = parseJson(row["payload_json"]);
      return {
        kind: "domain",
        worldSeq: Number(row["world_seq"]),
        worldTick: Number(row["world_tick"]),
        eventId: String(row["event_id"]) as TimelineItem["eventId"],
        type,
        principalId: String(row["principal_id"]) as TimelineItem["principalId"],
        audience: parseJson(row["audience_json"]) as TimelineItem["audience"],
        summaryZh: `${type} · ${String(row["principal_id"])}`,
        payload,
        correlationId: String(row["correlation_id"]),
        createdAt: String(row["committed_at"]),
      };
    });
    const lifecycleRows = this.storage.transact((tx) =>
      tx.all(
        `SELECT seq, type, subject_id, payload_json, created_at
           FROM lifecycle_events
          WHERE ${lifecycleConditions.join(" AND ")}
          ORDER BY created_at ${direction}, seq ${direction}
          LIMIT ?`,
        lifecycleParameters,
      ),
    );
    const lifecycleEvents: TimelineItem[] = lifecycleRows.map((row) => {
      const type = String(row["type"]);
      return {
        kind: "lifecycle",
        worldSeq: null,
        worldTick: null,
        eventId: null,
        type,
        principalId: row["subject_id"] === null ? null : String(row["subject_id"]) as TimelineItem["principalId"],
        audience: null,
        summaryZh: `${type} · ${row["subject_id"] === null ? "系统" : String(row["subject_id"])}`,
        payload: parseJson(row["payload_json"]),
        correlationId: null,
        createdAt: String(row["created_at"]),
      };
    });
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
    // 位置取自世界模块拥有的 character 聚合，水位滞后取该 Agent 已感知世界序号与全局最新序号之差：
    // 两者都是已持久化的事实，不再用固定的 null / 0 冒充，避免控制台永远显示「零滞后、位置未知」。
    const latestWorldSeq = this.storage.transact((tx) =>
      tx.branch(branchId).table("domain_events").max("world_seq"),
    );
    const rows = this.storage.transact((tx) =>
      tx.all(
        `SELECT a.agent_id, a.status, l.controller_kind, json_extract(roster.value, '$.kind') AS agent_kind,
                json_extract(character.state_json, '$.nodeId') AS node_id,
                (SELECT t.status FROM turn_runs t
                  WHERE t.branch_id = a.branch_id AND t.agent_id = a.agent_id
                  ORDER BY t.agent_turn_index DESC LIMIT 1) AS turn_status,
                (SELECT p.scanned_through_seq FROM perception_state p
                  WHERE p.branch_id = a.branch_id AND p.agent_id = a.agent_id) AS scanned_through_seq
           FROM agent_activations a
           JOIN branches b ON b.branch_id = a.branch_id
           JOIN runs r ON r.run_id = b.run_id
           JOIN json_each(r.manifest_json, '$.roster.agents') roster
             ON json_extract(roster.value, '$.agentId') = a.agent_id
           LEFT JOIN controller_leases l
             ON l.branch_id = a.branch_id AND l.agent_id = a.agent_id
           LEFT JOIN aggregate_state character
             ON character.branch_id = a.branch_id
            AND character.aggregate_type = 'character'
            AND character.aggregate_id = a.agent_id
          WHERE a.branch_id = ?
          ORDER BY a.agent_id`,
        [branchId],
      ),
    );
    const latest = Number(latestWorldSeq ?? 0);
    return {
      agents: rows.map((row) => {
        const nodeId = row["node_id"];
        const scanned = row["scanned_through_seq"];
        return {
          agentId: String(row["agent_id"]) as AgentsResponse["agents"][number]["agentId"],
          kind: row["agent_kind"] === "character" ? "character" : "strategic",
          active: row["status"] === "active",
          controllerKind: row["controller_kind"] === "human" ? "human" : "agent",
          location: typeof nodeId === "string" && nodeId.length > 0 ? nodeId : null,
          turnStatus: row["turn_status"] === null ? "idle" : String(row["turn_status"]),
          // 尚未建立感知水位的 Agent 视为滞后整条事件流，而不是滞后 0。
          watermarkLag: Math.max(0, latest - (typeof scanned === "number" ? scanned : 0)),
        };
      }),
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
    const state = this.storage.transact((tx) => {
      const branch = tx.branch(input.branchId);
      return {
        watermark: branch.table("memory_watermarks").get({ agent_id: input.agentId }),
        perception: branch.table("perception_state").get({ agent_id: input.agentId }),
      };
    });
    const revision = typeof state.watermark?.["revision"] === "number"
      ? state.watermark["revision"]
      : 0;
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
    const observationSeq = typeof state.watermark?.["observation_seq_consumed"] === "number"
      ? state.watermark["observation_seq_consumed"] : 0;
    const derivedThroughTick = typeof state.watermark?.["derived_through_tick"] === "number"
      ? state.watermark["derived_through_tick"] : 0;
    const perceptionRevision = typeof state.perception?.["revision"] === "number"
      ? state.perception["revision"] : 0;
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
    return new ResearchQueries(this.storage, this.host);
  }
}

function parseJson(value: unknown): Json {
  if (typeof value !== "string") {
    throw new DomainError("invalid-state", "观测记录的 JSON 列不是文本");
  }
  return jsonValueSchema.parse(JSON.parse(value));
}

export async function createObservabilityModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const storage = input.ports["platform.storage"];
  if (typeof storage !== "object" || storage === null) {
    throw new DomainError("assembly-incompatible", "观测模块缺少平台存储端口");
  }
  const config = configSchema.parse(input.config);
  return createStatelessModule(input, new ObservabilityPort(storage as StoragePort, config, input.host));
}
