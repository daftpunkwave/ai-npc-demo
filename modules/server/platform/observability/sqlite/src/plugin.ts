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
    const rows = this.storage.transact((tx) =>
      tx.all(
        `SELECT world_seq, world_tick, event_id, type, principal_id, audience_json,
                payload_json, correlation_id, committed_at
           FROM domain_events
          WHERE branch_id = ? AND world_seq > ?
          ORDER BY world_seq ASC
          LIMIT ?`,
        [query.branchId, query.fromSeq, Math.min(500, limit * 3)],
      ),
    );
    const events: TimelineItem[] = [];
    for (const row of rows) {
      const type = String(row["type"]);
      if (query.types !== undefined && !query.types.includes(type)) {
        continue;
      }
      const payload = parseJson(row["payload_json"]);
      if (query.agentId !== undefined && !containsText(payload, query.agentId) && row["principal_id"] !== query.agentId) {
        continue;
      }
      if (query.nodeId !== undefined && !containsText(payload, query.nodeId)) {
        continue;
      }
      events.push({
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
      });
      if (events.length >= limit) {
        break;
      }
    }
    if (events.length < limit) {
      const lifecycle = this.storage.transact((tx) =>
        tx.all(
          `SELECT seq, type, subject_id, payload_json, created_at
             FROM lifecycle_events
            WHERE branch_id = ?
            ORDER BY seq DESC
            LIMIT ?`,
          [query.branchId, limit - events.length],
        ),
      );
      for (const row of lifecycle) {
        const type = String(row["type"]);
        if (query.types !== undefined && !query.types.includes(type)) {
          continue;
        }
        events.push({
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
        });
      }
    }
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

function containsText(value: Json, needle: string): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsText(item, needle));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsText(item, needle));
  }
  return false;
}

export async function createObservabilityModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const storage = input.ports["platform.storage"];
  if (typeof storage !== "object" || storage === null) {
    throw new DomainError("assembly-incompatible", "观测模块缺少平台存储端口");
  }
  const config = configSchema.parse(input.config);
  return createStatelessModule(input, new ObservabilityPort(storage as StoragePort, config));
}
