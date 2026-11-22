/**
 * 核心职责：为控制台提供记忆、观察、turn、artifact、trace、分支差异与调试队列的只读查询。
 * 交互契约：依赖 StoragePort 的固定数据表与 HostServices 的 ID/时间；不触发模型、规则或后台任务。
 * 约束与禁忌：禁止返回未归档内容或无来源示例；原始 artifact 读取必须同时写审计生命周期事件。
 */
import {
  DomainError,
  inputFrontierSchema,
  jsonValueSchema,
  memoryDiffResponseSchema,
  memoryResponseSchema,
  observationsResponseSchema,
  traceResponseSchema,
  turnDetailSchema,
  turnStageViewSchema,
  turnSummarySchema,
  turnsResponseSchema,
  type ArtifactResponse,
  type BranchCompareResponse,
  type DebugQueuesResponse,
  type DebugWakeResponse,
  type HostServices,
  type Json,
  type MemoryDiffResponse,
  type MemoryResponse,
  type ObservationsResponse,
  type StoragePort,
  type StorageRow,
  type TraceResponse,
  type TraceSpan,
  type TurnDetail,
  type TurnSummary,
  type TurnsResponse,
} from "@ai-npc/contracts";
import { insertLifecycleAuditEvent } from "@ai-npc/module-sdk";
import {
  decodeMemoryRecord,
  decodeObservation,
  jsonColumn,
  nullableStringColumn,
  numberColumn,
  stringColumn,
  summaryFromRow,
  detailFromSummary,
} from "./research-codec";
import { compareBranchEvents, readDebugQueues, wakeDebugAgent } from "./debug-research";

type TurnFilters = {
  readonly runId?: string;
  readonly agentId?: string;
  readonly status?: string;
  readonly limit?: number;
};

function clampLimit(value: number | undefined, fallback = 50): number {
  return Math.max(1, Math.min(value ?? fallback, 200));
}

function parseArtifactBody(row: StorageRow): string {
  const body = row["body"];
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body === "string") return body;
  throw new DomainError("invalid-state", "artifact 正文缺失；当前首版只读取内联 artifact");
}

function parseJsonText(value: unknown): Json {
  if (typeof value !== "string") throw new DomainError("invalid-state", "观测 JSON 文本缺失");
  try {
    return jsonColumn(JSON.parse(value));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("invalid-state", "观测 JSON 文本无法解析");
  }
}

function triggerKinds(
  storage: StoragePort,
  branchId: string,
  ids: readonly string[],
): readonly string[] {
  if (ids.length === 0) return [];
  return storage.transact((tx) => {
    const placeholders = ids.map(() => "?").join(", ");
    return tx.all(
      `SELECT kind FROM triggers
        WHERE branch_id = ? AND trigger_id IN (${placeholders})`,
      [branchId, ...ids],
    ).map((row) => String(row["kind"]));
  });
}

function attemptStats(
  storage: StoragePort,
  turnId: string,
): { readonly calls: number; readonly tokens: TurnSummary["tokens"] } {
  return storage.transact((tx) => {
    const rows = tx.rows("model_attempts").list({ work_ref: turnId });
    if (rows.length === 0) return { calls: 0, tokens: { input: null, output: null } };
    let input = 0;
    let output = 0;
    for (const row of rows) {
      const usage = row["usage_json"];
      if (usage === null || Array.isArray(usage) || typeof usage !== "object" || usage instanceof Uint8Array) {
        return { calls: rows.length, tokens: { input: null, output: null } };
      }
      const inputValue = usage["inputTokens"];
      const outputValue = usage["outputTokens"];
      if (typeof inputValue !== "number" || typeof outputValue !== "number" ||
        !Number.isSafeInteger(inputValue) || !Number.isSafeInteger(outputValue) ||
        inputValue < 0 || outputValue < 0) {
        return { calls: rows.length, tokens: { input: null, output: null } };
      }
      input += inputValue;
      output += outputValue;
    }
    return { calls: rows.length, tokens: { input, output } };
  });
}

/** 把单行 turn、关联模型尝试与工具调用组装为摘要。 */
function summaryOf(storage: StoragePort, row: StorageRow): TurnSummary {
  const turnId = stringColumn(row, "turn_id");
  const branchId = stringColumn(row, "branch_id");
  const triggers = row["trigger_ids_json"];
  const triggerIds = Array.isArray(triggers)
    ? triggers.filter((value): value is string => typeof value === "string")
    : [];
  const stats = attemptStats(storage, turnId);
  const toolCalls = storage.transact((tx) => tx.rows("tool_calls").list({ turn_id: turnId }).length);
  return turnSummarySchema.parse(summaryFromRow({
    row,
    triggerKinds: triggerKinds(storage, branchId, triggerIds),
    modelCalls: stats.calls,
    toolCalls,
    tokens: stats.tokens,
  }));
}

function readWorldId(storage: StoragePort, branchId: string): string {
  const worldId = storage.transact((tx) => tx.rows("branches").get({ branch_id: branchId })?.["world_id"]);
  if (typeof worldId !== "string") throw new DomainError("not-found", `分支 ${branchId} 不存在`);
  return worldId;
}

function decodeTurns(storage: StoragePort, rows: readonly StorageRow[]): readonly TurnSummary[] {
  return rows.map((row) => summaryOf(storage, row));
}

export class ResearchQueries {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
  ) {}

  memory(branchId: string, agentId: string, revision: number): MemoryResponse {
    const worldId = readWorldId(this.storage, branchId);
    const rows = this.storage.transact((tx) => tx.branch(branchId).table("memory_records")
      .list({ agent_id: agentId }, { orderBy: [{ column: "memory_id" }, { column: "row_version" }] })
      .filter((row) =>
        Number(row["created_revision"]) <= revision &&
        (row["retired_revision"] === null || Number(row["retired_revision"]) > revision)));
    return memoryResponseSchema.parse({
      revision,
      records: rows.map((row) => decodeMemoryRecord(row, { worldId, branchId, agentId, revision })),
    });
  }

  memoryDiff(branchId: string, agentId: string, from: number, to: number): MemoryDiffResponse {
    const before = new Map(this.memory(branchId, agentId, from).records.map((record) => [record.memoryId, record]));
    const after = new Map(this.memory(branchId, agentId, to).records.map((record) => [record.memoryId, record]));
    const added = [...after.keys()].filter((memoryId) => !before.has(memoryId));
    const retired = [...before.keys()].filter((memoryId) => !after.has(memoryId));
    const changed = [...after.keys()].filter((memoryId) =>
      before.has(memoryId) &&
      JSON.stringify(before.get(memoryId)?.content) !== JSON.stringify(after.get(memoryId)?.content));
    const entry = (memoryId: string) => {
      const record = after.get(memoryId) ?? before.get(memoryId);
      return {
        memoryId: memoryId as MemoryDiffResponse["added"][number]["memoryId"],
        sourceObservationIds: record?.sourceObservationIds ?? [],
      };
    };
    return memoryDiffResponseSchema.parse({
      added: added.map(entry),
      retired: retired.map(entry),
      changed: changed.map(entry),
    });
  }

  observations(branchId: string, agentId: string, fromSeq: number, limit: number): ObservationsResponse {
    const worldId = readWorldId(this.storage, branchId);
    const bounded = Math.max(1, Math.min(limit, 200));
    const rows = this.storage.transact((tx) => tx.branch(branchId).table("observations")
      .list({ agent_id: agentId }, { orderBy: [{ column: "observation_seq" }] })
      .filter((row) => Number(row["observation_seq"]) > fromSeq)
      .slice(0, bounded));
    return observationsResponseSchema.parse({
      observations: rows.map((row) => decodeObservation(row, { worldId, branchId, agentId })),
    });
  }

  turns(query: TurnFilters): TurnsResponse {
    const filter: Record<string, string> = {};
    if (query.runId !== undefined) filter["run_id"] = query.runId;
    if (query.agentId !== undefined) filter["agent_id"] = query.agentId;
    if (query.status !== undefined) filter["status"] = query.status;
    const rows = this.storage.transact((tx) => tx.rows("turn_runs").list(
      filter,
      {
        orderBy: [{ column: "created_at", direction: "desc" }],
        limit: clampLimit(query.limit),
      },
    ));
    return turnsResponseSchema.parse({ turns: decodeTurns(this.storage, rows) });
  }

  turn(turnId: string): TurnDetail {
    const row = this.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: turnId }));
    if (row === null) throw new DomainError("not-found", `turn ${turnId} 不存在`);
    const summary = summaryOf(this.storage, row);
    const branchId = summary.branchId;
    const effective = Array.isArray(row["effective_json"]) ? row["effective_json"] : [];
    const stages = effective.map((entry) => turnStageViewSchema.parse(entry));
    const attempts = this.storage.transact((tx) => tx.rows("model_attempts")
      .list({ work_ref: turnId }, { orderBy: [{ column: "created_at" }, { column: "attempt_id" }] }))
      .map((attempt) => ({
      attemptId: String(attempt["attempt_id"]) as TurnDetail["attempts"][number]["attemptId"],
      purpose: String(attempt["purpose"]),
      modelId: String(attempt["model_id"]),
      status: String(attempt["status"]),
      isEffective: attempt["is_effective"] === 1,
      requestArtifactId: attempt["request_artifact_id"] === null
        ? null : String(attempt["request_artifact_id"]) as TurnDetail["attempts"][number]["requestArtifactId"],
      responseArtifactId: attempt["response_artifact_id"] === null
        ? null : String(attempt["response_artifact_id"]) as TurnDetail["attempts"][number]["responseArtifactId"],
      usage: jsonColumn(attempt["usage_json"]),
      error: attempt["error_json"] === null ? null : jsonColumn(attempt["error_json"]),
    }));
    const toolCalls = this.storage.transact((tx) => tx.rows("tool_calls")
      .list({ turn_id: turnId }, { orderBy: [{ column: "created_at" }, { column: "tool_call_id" }] }))
      .map((call) => ({
      toolCallId: String(call["tool_call_id"]),
      toolId: String(call["tool_id"]),
      executionStatus: call["execution_status"] as TurnDetail["toolCalls"][number]["executionStatus"],
      commandStatus: (call["command_id"] === null
        ? null
        : call["execution_status"] === "ok" ? "accepted" : "rejected") as
        TurnDetail["toolCalls"][number]["commandStatus"],
      rawArtifactId: call["raw_artifact_id"] === null ? null : String(call["raw_artifact_id"]),
      viewArtifactId: call["view_artifact_id"] === null ? null : String(call["view_artifact_id"]),
      operationId: call["operation_id"] === null ? null : String(call["operation_id"]),
    }));
    const frontier = row["input_frontier_json"] === null
      ? null : inputFrontierSchema.parse(row["input_frontier_json"]);
    const trace = this.storage.transact((tx) => tx.all(
      `SELECT trace_id FROM trace_spans
        WHERE turn_id = ? ORDER BY CASE WHEN name = 'turn' THEN 0 ELSE 1 END, start_ms LIMIT 1`,
      [turnId],
    ))[0]?.["trace_id"];
    if (typeof trace !== "string") throw new DomainError("invalid-state", `turn ${turnId} 缺少 trace`);
    const artifactIds = stages.flatMap((stage) => {
      if (stage.stage !== "turn.context" && stage.stage !== "turn.compression") return [];
      if (stage.effective === null || Array.isArray(stage.effective) || typeof stage.effective !== "object") return [];
      const id = stage.effective["artifactId"];
      return typeof id === "string" ? [id as TurnDetail["contextArtifactIds"][number]] : [];
    });
    const speechId = stages.find((stage) => stage.stage === "turn.speech")?.effective;
    const speechArtifactId = speechId !== null && !Array.isArray(speechId) && typeof speechId === "object" &&
      typeof speechId["artifactId"] === "string" ? speechId["artifactId"] : null;
    const speech = speechArtifactId === null ? null : this.speechOf(speechArtifactId);
    return turnDetailSchema.parse(detailFromSummary(summary, {
      inputFrontier: frontier,
      memoryRevision: row["memory_revision"] === null ? null : numberColumn(row, "memory_revision"),
      stages,
      contextArtifactIds: [...new Set(artifactIds)],
      attempts,
      toolCalls,
      decision: this.decisionOf(stages),
      speech,
      traceId: trace,
    }));
  }

  private decisionOf(stages: readonly TurnDetail["stages"][number][]): Json | null {
    const id = stages.find((stage) => stage.stage === "turn.decision")?.effective;
    if (id === null || id === undefined || Array.isArray(id) || typeof id !== "object" ||
      typeof id["artifactId"] !== "string") return null;
    const value = this.artifactValue(id["artifactId"]);
    return value !== null && !Array.isArray(value) && typeof value === "object" && "decision" in value
      ? value["decision"] ?? null
      : null;
  }

  private speechOf(artifactId: string): TurnDetail["speech"] {
    const value = this.artifactValue(artifactId);
    if (value === null || Array.isArray(value) || typeof value !== "object" ||
      typeof value["text"] !== "string" || typeof value["fallback"] !== "boolean") return null;
    return {
      speechArtifactId: artifactId as NonNullable<TurnDetail["speech"]>["speechArtifactId"],
      text: value["text"],
      fallback: value["fallback"],
    };
  }

  private artifactValue(artifactId: string): Json | null {
    const row = this.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
    if (row === null) return null;
    const body = parseArtifactBody(row);
    try {
      return jsonColumn(JSON.parse(body));
    } catch {
      throw new DomainError("invalid-state", `artifact ${artifactId} 的正文无法解析`);
    }
  }

  artifact(artifactId: string, view: "redacted" | "raw"): ArtifactResponse {
    const row = this.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
    if (row === null) throw new DomainError("not-found", `artifact ${artifactId} 不存在`);
    const body = parseArtifactBody(row);
    if (view === "raw") {
      this.storage.transact((tx) => insertLifecycleAuditEvent(tx, {
        runId: row["run_id"] === null ? null : String(row["run_id"]),
        branchId: null,
        type: "ArtifactViewed",
        subjectId: null,
        payload: { artifactId, view },
        createdAt: this.host.nowIso(),
      }));
    }
    return { artifactId: artifactId as ArtifactResponse["artifactId"], view, body };
  }

  trace(traceId: string): TraceResponse {
    const rows = this.storage.transact((tx) => tx.all(
      `SELECT span_id, trace_id, parent_span_id, name, attrs_json, start_ms, end_ms
         FROM trace_spans WHERE trace_id = ? ORDER BY start_ms, span_id`,
      [traceId],
    ));
    if (rows.length === 0) throw new DomainError("not-found", `trace ${traceId} 不存在`);
    const nodes = rows.map((row): TraceSpan => ({
      spanId: String(row["span_id"]),
      traceId: String(row["trace_id"]),
      parentSpanId: row["parent_span_id"] === null ? null : String(row["parent_span_id"]),
      name: String(row["name"]),
      attrs: jsonColumn(parseJsonText(row["attrs_json"])),
      startedAt: new Date(Number(row["start_ms"])).toISOString(),
      durationMs: row["end_ms"] === null ? null : Math.max(0, Number(row["end_ms"]) - Number(row["start_ms"])),
      children: [],
    }));
    const byId = new Map(nodes.map((node) => [node.spanId, { ...node, children: [] as TraceSpan[] }]));
    const roots: TraceSpan[] = [];
    for (const node of byId.values()) {
      const parent = node.parentSpanId === null ? undefined : byId.get(node.parentSpanId);
      if (parent !== undefined) parent.children.push(node);
      else roots.push(node);
    }
    const selectedRoot = roots.find((node) => node.name === "turn") ?? roots[0];
    if (selectedRoot === undefined) throw new DomainError("invalid-state", `trace ${traceId} 没有根 span`);
    // 早期 turn span 都是平铺根节点；同一 trace 的根节点在这里归入选定根节点展示。
    if (roots.length > 1) {
      const mutableRoot = selectedRoot as TraceSpan & { children: TraceSpan[] };
      mutableRoot.children.push(...roots.filter((node) => node !== selectedRoot));
    }
    return traceResponseSchema.parse({ traceId, root: selectedRoot });
  }

  branchCompare(left: string, right: string, atSeq: number): BranchCompareResponse {
    return compareBranchEvents(this.storage, left, right, atSeq);
  }

  debugQueues(branchId: string): DebugQueuesResponse {
    return readDebugQueues(this.storage, branchId);
  }

  debugWake(branchId: string, agentId: string, reason: string, operationId: string): DebugWakeResponse {
    return wakeDebugAgent(this.storage, this.host, branchId, agentId, reason, operationId);
  }
}
