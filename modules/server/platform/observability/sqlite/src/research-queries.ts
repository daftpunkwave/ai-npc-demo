/**
 * 核心职责：为控制台提供记忆、观察、turn、artifact、trace、分支差异与调试队列的只读查询，并转交调试唤醒。
 * 交互契约：他人拥有的数据只经注入的数据源端口读取；本模块的 StoragePort 只用于自有的 trace_spans 与
 *   生命周期审计写入；HostServices 只提供审计时间。不触发模型、规则或后台任务。
 * 约束与禁忌：禁止返回未归档内容或无来源示例；原始 artifact 读取必须同时写审计生命周期事件。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-redundant-type-constituents -- 构造器参数属性通过 this 使用，Codacy 缺少 workspace 类型解析时会把契约联合判成 any。 */
import {
  DomainError,
  debugWakeResponseSchema,
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
  type TraceResponse,
  type TraceSpan,
  type TurnDetail,
  type TurnsResponse,
} from "@world-prism/contracts";
import { insertLifecycleAuditEvent, type ObservabilitySources } from "@world-prism/module-sdk";
import {
  jsonColumn,
  parseJsonText,
  stringColumn,
  detailFromSummary,
} from "./research-codec";
import { compareBranchEvents, readDebugQueues } from "./debug-research";
import { readMemory, readMemoryDiff, readObservations } from "./memory-research";
import { summarizeTurns } from "./turn-summary-query";

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

export class ResearchQueries {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
    private readonly sources: ObservabilitySources,
  ) {}

  memory(branchId: string, agentId: string, revision: number): MemoryResponse {
    return readMemory(this.sources, branchId, agentId, revision);
  }

  memoryDiff(branchId: string, agentId: string, from: number, to: number): MemoryDiffResponse {
    return readMemoryDiff(this.sources, branchId, agentId, from, to);
  }

  observations(branchId: string, agentId: string, fromSeq: number, limit: number): ObservationsResponse {
    return readObservations(this.sources, branchId, agentId, fromSeq, limit);
  }

  turns(query: TurnFilters): TurnsResponse {
    const turns = this.sources.read((reader) => summarizeTurns(reader, reader.turnRuns({
      worldId: query.worldId,
      runId: query.runId,
      branchId: query.branchId,
      agentId: query.agentId,
      status: query.status,
      limit: clampLimit(query.limit),
    })));
    return turnsResponseSchema.parse({ turns });
  }

  turn(turnId: string): TurnDetail {
    const { run, summary, attempts, toolCalls } = this.sources.read((reader) => {
      const run = reader.turnRun(turnId);
      if (run === null) throw new DomainError("not-found", `turn ${turnId} 不存在`);
      const [summary] = summarizeTurns(reader, [run]);
      if (summary === undefined) throw new DomainError("invalid-state", `turn ${turnId} 缺少摘要`);
      const attempts = reader.turnModelAttempts(run.runId, turnId).map((attempt) => ({
        attemptId: attempt.attemptId as TurnDetail["attempts"][number]["attemptId"],
        purpose: attempt.purpose,
        modelId: attempt.modelId,
        status: attempt.status,
        isEffective: attempt.isEffective,
        requestArtifactId: attempt.requestArtifactId as TurnDetail["attempts"][number]["requestArtifactId"],
        responseArtifactId: attempt.responseArtifactId as TurnDetail["attempts"][number]["responseArtifactId"],
        usage: attempt.usage,
        error: attempt.error,
      }));
      const toolCalls = reader.turnToolCalls(run.runId, turnId).map((call) => ({
        toolCallId: call.toolCallId,
        toolId: call.toolId,
        executionStatus: call.executionStatus,
        commandStatus: call.commandId === null ? null : reader.commandStatus(run.branchId, run.agentId, call.commandId),
        rawArtifactId: call.rawArtifactId,
        viewArtifactId: call.viewArtifactId,
        operationId: call.operationId,
      }));
      return { run, summary, attempts, toolCalls };
    });
    const effective = Array.isArray(run.effective) ? run.effective : [];
    const stages = effective.map((entry) => turnStageViewSchema.parse(entry));
    const frontier = run.inputFrontier === null ? null : inputFrontierSchema.parse(run.inputFrontier);
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
      memoryRevision: run.memoryRevision,
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
    const artifact = this.sources.artifactBody(artifactId);
    if (artifact === null) return null;
    try {
      return jsonColumn(JSON.parse(artifact.body));
    } catch {
      throw new DomainError("invalid-state", `artifact ${artifactId} 的正文无法解析`);
    }
  }

  artifact(artifactId: string, view: "redacted" | "raw", principalId: string): ArtifactResponse {
    const artifact = this.sources.artifactBody(artifactId);
    if (artifact === null) throw new DomainError("not-found", `artifact ${artifactId} 不存在`);
    if (view === "raw") {
      this.storage.transact((tx) => insertLifecycleAuditEvent(tx, {
        runId: artifact.runId,
        branchId: null,
        type: "ArtifactViewed",
        subjectId: principalId,
        payload: { artifactId, view, principalId },
        createdAt: this.host.nowIso(),
      }));
    }
    return { artifactId: artifactId as ArtifactResponse["artifactId"], view, body: artifact.body };
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
    return compareBranchEvents(this.sources, left, right, atSeq);
  }

  debugQueues(branchId: string): DebugQueuesResponse {
    return readDebugQueues(this.sources, branchId);
  }

  debugWake(input: DebugWakeInput): DebugWakeResponse {
    this.sources.requestDebugWake(input);
    return debugWakeResponseSchema.parse({ ok: true });
  }
}
