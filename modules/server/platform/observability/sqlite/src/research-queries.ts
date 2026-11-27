/**
 * 核心职责：为控制台提供记忆、观察、turn、artifact、trace、分支差异与调试队列的只读查询。
 * 交互契约：依赖 StoragePort 的固定数据表与 HostServices 的 ID/时间；不触发模型、规则或后台任务。
 * 约束与禁忌：禁止返回未归档内容或无来源示例；原始 artifact 读取必须同时写审计生命周期事件。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 构造器参数属性通过 this 使用，Codacy 缺少 workspace 类型解析时会把契约联合判成 any。 */
import {
  DomainError,
  inputFrontierSchema,
  traceResponseSchema,
  turnDetailSchema,
  turnStageViewSchema,
  turnsResponseSchema,
  type ArtifactResponse,
  type BranchCompareResponse,
  type DebugQueuesResponse,
  type DebugWakeInput,
  type DebugWakeResponse,
  type HostServices,
  type Json,
  type MemoryDiffResponse,
  type MemoryResponse,
  type ObservationsResponse,
  type StoragePort,
  type StorageRow,
  type StorageTransaction,
  type StorageValue,
  type TraceResponse,
  type TraceSpan,
  type TurnDetail,
  type TurnsResponse,
} from "@world-prism/contracts";
import { artifactBodyText, insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import {
  jsonColumn,
  numberColumn,
  parseJsonText,
  stringColumn,
  detailFromSummary,
} from "./research-codec";
import { compareBranchEvents, readDebugQueues, wakeDebugAgent } from "./debug-research";
import { readMemory, readMemoryDiff, readObservations } from "./memory-research";
import { readTurnSummaries } from "./turn-summary-query";

type TurnFilters = {
  readonly runId?: string;
  readonly branchId?: string;
  readonly worldId?: string;
  readonly agentId?: string;
  readonly status?: string;
  readonly limit?: number;
};

function clampLimit(value: number | undefined, fallback = 50): number {
  return Math.max(1, Math.min(value ?? fallback, 200));
}

/** 在事务外取回 artifact 正文：内联行直接解码，文件行读取正文文件；正文缺失或不可读时报告状态异常。 */
function parseArtifactBody(storage: StoragePort, row: StorageRow): string {
  try {
    return artifactBodyText(storage, row);
  } catch (error) {
    throw new DomainError("invalid-state", "artifact 正文缺失或无法读取", { cause: error });
  }
}

function receiptStatus(
  tx: StorageTransaction,
  branchId: string,
  agentId: string,
  commandId: string | null,
): TurnDetail["toolCalls"][number]["commandStatus"] {
  if (commandId === null) return null;
  const value = tx.get(
    `SELECT receipt_json FROM command_receipts
      WHERE branch_id = ? AND principal_id = ? AND command_id = ?`,
    [branchId, agentId, commandId],
  )?.["receipt_json"];
  if (typeof value !== "string") return null;
  try {
    const receipt = jsonColumn(JSON.parse(value));
    if (Array.isArray(receipt) || receipt === null || typeof receipt !== "object") return null;
    return receipt["commandStatus"] === "accepted" || receipt["commandStatus"] === "rejected"
      ? receipt["commandStatus"]
      : null;
  } catch {
    throw new DomainError("invalid-state", `command receipt ${commandId} 不是合法 JSON`);
  }
}

export class ResearchQueries {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
  ) {}

  memory(branchId: string, agentId: string, revision: number): MemoryResponse {
    return readMemory(this.storage, branchId, agentId, revision);
  }

  memoryDiff(branchId: string, agentId: string, from: number, to: number): MemoryDiffResponse {
    return readMemoryDiff(this.storage, branchId, agentId, from, to);
  }

  observations(branchId: string, agentId: string, fromSeq: number, limit: number): ObservationsResponse {
    return readObservations(this.storage, branchId, agentId, fromSeq, limit);
  }

  turns(query: TurnFilters): TurnsResponse {
    const conditions: string[] = [];
    const parameters: StorageValue[] = [];
    if (query.worldId !== undefined) {
      conditions.push("b.world_id = ?");
      parameters.push(query.worldId);
    }
    if (query.runId !== undefined) {
      conditions.push("t.run_id = ?");
      parameters.push(query.runId);
    }
    if (query.branchId !== undefined) {
      conditions.push("t.branch_id = ?");
      parameters.push(query.branchId);
    }
    if (query.agentId !== undefined) {
      conditions.push("t.agent_id = ?");
      parameters.push(query.agentId);
    }
    if (query.status !== undefined) {
      conditions.push("t.status = ?");
      parameters.push(query.status);
    }
    parameters.push(clampLimit(query.limit));
    const turns = this.storage.transact((tx) => {
      const rows = tx.all(
        `SELECT t.* FROM turn_runs t
          JOIN branches b ON b.branch_id = t.branch_id
          ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY t.created_at DESC LIMIT ?`,
        parameters,
      );
      return readTurnSummaries(tx, rows);
    });
    return turnsResponseSchema.parse({ turns });
  }

  turn(turnId: string): TurnDetail {
    const { row, summary } = this.storage.transact((tx) => {
      const row = tx.rows("turn_runs").get({ turn_id: turnId });
      if (row === null) throw new DomainError("not-found", `turn ${turnId} 不存在`);
      const [summary] = readTurnSummaries(tx, [row]);
      if (summary === undefined) throw new DomainError("invalid-state", `turn ${turnId} 缺少摘要`);
      return { row, summary };
    });
    const effective = Array.isArray(row["effective_json"]) ? row["effective_json"] : [];
    const stages = effective.map((entry) => turnStageViewSchema.parse(entry));
    const attempts = this.storage.transact((tx) => tx.rows("model_attempts")
      .list({ run_id: summary.runId, work_ref: turnId }, { orderBy: [{ column: "created_at" }, { column: "attempt_id" }] }))
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
    const toolCalls = this.storage.transact((tx) => {
      const { branchId, agentId } = summary;
      return tx.rows("tool_calls")
        .list({ run_id: summary.runId, turn_id: turnId }, { orderBy: [{ column: "created_at" }, { column: "tool_call_id" }] })
        .map((call) => {
          const commandId = call["command_id"] === null ? null : String(call["command_id"]);
          return {
            toolCallId: String(call["tool_call_id"]),
            toolId: String(call["tool_id"]),
            executionStatus: call["execution_status"] as TurnDetail["toolCalls"][number]["executionStatus"],
            commandStatus: receiptStatus(tx, branchId, agentId, commandId),
            rawArtifactId: call["raw_artifact_id"] === null ? null : String(call["raw_artifact_id"]),
            viewArtifactId: call["view_artifact_id"] === null ? null : String(call["view_artifact_id"]),
            operationId: call["operation_id"] === null ? null : String(call["operation_id"]),
          };
        });
    });
    const frontier = row["input_frontier_json"] === null
      ? null : inputFrontierSchema.parse(row["input_frontier_json"]);
    const trace = this.storage.transact((tx) => tx.all(
      `SELECT trace_id FROM trace_spans
        WHERE turn_id = ? ORDER BY CASE WHEN name = 'turn' THEN 0 ELSE 1 END, start_ms LIMIT 1`,
      [turnId],
    ))[0]?.["trace_id"];
    const traceId = typeof trace === "string" ? trace : null;
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
      traceId,
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
    const body = parseArtifactBody(this.storage, row);
    try {
      return jsonColumn(JSON.parse(body));
    } catch {
      throw new DomainError("invalid-state", `artifact ${artifactId} 的正文无法解析`);
    }
  }

  artifact(artifactId: string, view: "redacted" | "raw", principalId: string): ArtifactResponse {
    const row = this.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
    if (row === null) throw new DomainError("not-found", `artifact ${artifactId} 不存在`);
    const body = parseArtifactBody(this.storage, row);
    if (view === "raw") {
      this.storage.transact((tx) => insertLifecycleAuditEvent(tx, {
        runId: row["run_id"] === null ? null : String(row["run_id"]),
        branchId: null,
        type: "ArtifactViewed",
        subjectId: principalId,
        payload: { artifactId, view, principalId },
        createdAt: this.host.nowIso(),
      }));
    }
    return { artifactId: artifactId as ArtifactResponse["artifactId"], view, body };
  }

  trace(traceId: string): TraceResponse {
    const rows = this.storage.transact((tx) => tx.all(
      `SELECT span_id, trace_id, parent_span_id, name, attrs_json, start_ms, end_ms, started_at
         FROM trace_spans WHERE trace_id = ? ORDER BY start_ms, span_id`,
      [traceId],
    ));
    if (rows.length === 0) throw new DomainError("not-found", `trace ${traceId} 不存在`);
    const nodes = rows.map((row): TraceSpan => ({
      spanId: String(row["span_id"]),
      traceId: String(row["trace_id"]),
      parentSpanId: row["parent_span_id"] === null ? null : String(row["parent_span_id"]),
      name: String(row["name"]),
      attrs: parseJsonText(row["attrs_json"]),
      startedAt: row["started_at"] === null ? null : stringColumn(row, "started_at"),
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

  debugWake(input: DebugWakeInput): DebugWakeResponse {
    return wakeDebugAgent(this.storage, this.host, input);
  }
}
