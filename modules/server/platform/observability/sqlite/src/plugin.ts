/**
 * 使用固定 trace_spans、domain_events 与生命周期表提供观测写入和只读查询。
 * 依赖注入的 StoragePort、模块生命周期与公共 DTO；不改变世界事实或 Agent 记忆。
 * 禁止在模块内执行模型调用、删除审计记录或返回未授权原文。
 */
import {
  DomainError,
  jsonValueSchema,
  type AgentsResponse,
  type Json,
  type ModuleCreateInput,
  type ModuleInstance,
  type StorageValue,
  type StoragePort,
  type TimelineItem,
  type TimelineResponse,
} from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const configSchema = z.object({
  timelineLimit: z.number().int().min(1).max(1_000),
}).strict();

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

  constructor(storage: StoragePort, config: { readonly timelineLimit: number }) {
    this.storage = storage;
    this.maxTimelineLimit = config.timelineLimit;
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
        attrs_json: span.attrs,
      });
    });
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
    const rows = this.storage.transact((tx) =>
      tx.all(
        `SELECT a.agent_id, a.status, l.controller_kind, t.status AS turn_status
           FROM agent_activations a
           LEFT JOIN controller_leases l
             ON l.branch_id = a.branch_id AND l.agent_id = a.agent_id
           LEFT JOIN turn_runs t
             ON t.branch_id = a.branch_id AND t.agent_id = a.agent_id
          WHERE a.branch_id = ?
          ORDER BY a.agent_id`,
        [branchId],
      ),
    );
    return {
      agents: rows.map((row) => ({
        agentId: String(row["agent_id"]) as AgentsResponse["agents"][number]["agentId"],
        kind: String(row["agent_id"]).startsWith("human-") ? "strategic" : "character",
        active: row["status"] === "active",
        controllerKind: row["controller_kind"] === "human" ? "human" : "agent",
        location: null,
        turnStatus: row["turn_status"] === null ? "idle" : String(row["turn_status"]),
        watermarkLag: 0,
      })),
    };
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
  return createStatelessModule(input, new ObservabilityPort(storage as StoragePort, config));
}
