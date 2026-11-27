/**
 * 核心职责：为观测数据源提供 turn 证据的只读查询：turn 列表与单个 turn、关联触发种类、工具调用、
 *   模型尝试与用量、调度队列计数，并在本文件内把列映射为类型化记录。
 * 交互契约：在调用方事务内执行；turn_runs、triggers、tool_calls 由 agent-runtime 写入，model_attempts 由模型池
 *   按 turn 证据契约写入；按世界或分支收窄时关联分支与 run 登记表，只读其归属列。
 * 约束与禁忌：只读；批量统计必须一次查询覆盖全部 turn，不得逐 turn 回表；不为缺失用量补零；
 *   列不合法时以 invalid-state 失败。
 */
import {
  DomainError,
  executionStatusSchema,
  type Json,
  type StorageRawRow,
  type StorageRow,
  type StorageTransaction,
  type StorageValue,
} from "@world-prism/contracts";
import type {
  ObservedModelAttempt,
  ObservedSchedulerQueue,
  ObservedToolCall,
  ObservedTurnRun,
  TurnRunFilter,
} from "@world-prism/module-sdk";
import {
  countCell,
  jsonCell,
  jsonTextCell,
  nullableCountCell,
  nullableTextCell,
  textArrayOf,
  textCell,
  type RuntimeRow,
} from "./runtime-query-cells";

function turnRunOf(row: RuntimeRow, json: (column: string) => Json): ObservedTurnRun {
  return {
    turnId: textCell(row, "turn_runs", "turn_id"),
    runId: textCell(row, "turn_runs", "run_id"),
    branchId: textCell(row, "turn_runs", "branch_id"),
    agentId: textCell(row, "turn_runs", "agent_id"),
    agentTurnIndex: countCell(row, "turn_runs", "agent_turn_index"),
    status: textCell(row, "turn_runs", "status"),
    triggerIds: textArrayOf(json("trigger_ids_json"), "turn_runs", "trigger_ids_json"),
    inputFrontier: json("input_frontier_json"),
    memoryRevision: nullableCountCell(row, "turn_runs", "memory_revision"),
    terminalReason: nullableTextCell(row, "turn_runs", "terminal_reason"),
    effective: json("effective_json"),
    createdAt: textCell(row, "turn_runs", "created_at"),
    endedAt: nullableTextCell(row, "turn_runs", "ended_at"),
  };
}

/** 按筛选列出 turn，创建时间倒序；按世界筛选经分支登记的 world_id 收窄。 */
export function listTurnRuns(tx: StorageTransaction, filter: TurnRunFilter): readonly ObservedTurnRun[] {
  const conditions: string[] = [];
  const parameters: StorageValue[] = [];
  const equals = (column: string, value: string | undefined): void => {
    if (value === undefined) return;
    conditions.push(`${column} = ?`);
    parameters.push(value);
  };
  equals("b.world_id", filter.worldId);
  equals("t.run_id", filter.runId);
  equals("t.branch_id", filter.branchId);
  equals("t.agent_id", filter.agentId);
  equals("t.status", filter.status);
  parameters.push(filter.limit);
  return tx.all(
    `SELECT t.* FROM turn_runs t
      JOIN branches b ON b.branch_id = t.branch_id
      ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
     ORDER BY t.created_at DESC LIMIT ?`,
    parameters,
  ).map((row) => turnRunOf(row, (column) => jsonTextCell(row, "turn_runs", column)));
}

/** 读取单个 turn；不存在时为 null。 */
export function readTurnRun(tx: StorageTransaction, turnId: string): ObservedTurnRun | null {
  const row = tx.rows("turn_runs").get({ turn_id: turnId });
  return row === null ? null : turnRunOf(row, (column) => jsonCell(row, "turn_runs", column));
}

function placeholdersFor(turnIds: readonly string[]): string {
  return turnIds.map(() => "?").join(", ");
}

/** 每个 turn 关联触发的种类，按触发 ID 升序；触发须与 turn 同分支。 */
export function listTurnTriggerKinds(
  tx: StorageTransaction,
  turnIds: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const kinds = new Map<string, string[]>();
  if (turnIds.length === 0) return kinds;
  for (const row of tx.all(
    `SELECT DISTINCT t.turn_id, g.trigger_id, g.kind
       FROM turn_runs t
       JOIN json_each(t.trigger_ids_json) ids
       JOIN triggers g ON g.branch_id = t.branch_id AND g.trigger_id = ids.value
      WHERE t.turn_id IN (${placeholdersFor(turnIds)})
      ORDER BY t.turn_id, g.trigger_id`,
    turnIds,
  )) {
    const turnId = textCell(row, "turn_runs", "turn_id");
    const kind = textCell(row, "triggers", "kind");
    const list = kinds.get(turnId);
    if (list === undefined) kinds.set(turnId, [kind]);
    else list.push(kind);
  }
  return kinds;
}

/** 每个 turn 在其所属 run 内的工具调用数。 */
export function countTurnToolCalls(tx: StorageTransaction, turnIds: readonly string[]): ReadonlyMap<string, number> {
  if (turnIds.length === 0) return new Map();
  return new Map(tx.all(
    `SELECT t.turn_id, COUNT(*) AS calls
       FROM turn_runs t
       JOIN tool_calls c ON c.run_id = t.run_id AND c.turn_id = t.turn_id
      WHERE t.turn_id IN (${placeholdersFor(turnIds)})
      GROUP BY t.turn_id`,
    turnIds,
  ).map((row) => [textCell(row, "turn_runs", "turn_id"), countCell(row, "tool_calls", "calls")]));
}

/** 每个 turn 在其所属 run 内各次模型尝试的用量；未记录用量为 null。 */
export function listTurnModelUsages(
  tx: StorageTransaction,
  turnIds: readonly string[],
): ReadonlyMap<string, readonly Json[]> {
  const usages = new Map<string, Json[]>();
  if (turnIds.length === 0) return usages;
  for (const row of tx.all(
    `SELECT t.turn_id, a.usage_json
       FROM turn_runs t
       JOIN model_attempts a ON a.run_id = t.run_id AND a.work_ref = t.turn_id
      WHERE t.turn_id IN (${placeholdersFor(turnIds)})`,
    turnIds,
  )) {
    const turnId = textCell(row, "turn_runs", "turn_id");
    const usage = jsonTextCell(row, "model_attempts", "usage_json");
    const list = usages.get(turnId);
    if (list === undefined) usages.set(turnId, [usage]);
    else list.push(usage);
  }
  return usages;
}

function modelAttemptOf(row: StorageRow): ObservedModelAttempt {
  return {
    attemptId: textCell(row, "model_attempts", "attempt_id"),
    purpose: textCell(row, "model_attempts", "purpose"),
    modelId: textCell(row, "model_attempts", "model_id"),
    status: textCell(row, "model_attempts", "status"),
    isEffective: row["is_effective"] === 1,
    requestArtifactId: nullableTextCell(row, "model_attempts", "request_artifact_id"),
    responseArtifactId: nullableTextCell(row, "model_attempts", "response_artifact_id"),
    usage: jsonCell(row, "model_attempts", "usage_json"),
    error: row["error_json"] === null ? null : jsonCell(row, "model_attempts", "error_json"),
  };
}

/** turn 的模型尝试，按创建时间与尝试 ID 升序。 */
export function listTurnModelAttempts(
  tx: StorageTransaction,
  runId: string,
  turnId: string,
): readonly ObservedModelAttempt[] {
  return tx.rows("model_attempts")
    .list({ run_id: runId, work_ref: turnId }, { orderBy: [{ column: "created_at" }, { column: "attempt_id" }] })
    .map(modelAttemptOf);
}

function toolCallOf(row: StorageRow): ObservedToolCall {
  const execution = row["execution_status"];
  const executionStatus = execution === null ? null : executionStatusSchema.safeParse(execution);
  if (executionStatus !== null && !executionStatus.success) {
    throw new DomainError("invalid-state", "存储表 tool_calls 的列 execution_status 不在登记集合内");
  }
  return {
    toolCallId: textCell(row, "tool_calls", "tool_call_id"),
    toolId: textCell(row, "tool_calls", "tool_id"),
    executionStatus: executionStatus === null ? null : executionStatus.data,
    commandId: nullableTextCell(row, "tool_calls", "command_id"),
    rawArtifactId: nullableTextCell(row, "tool_calls", "raw_artifact_id"),
    viewArtifactId: nullableTextCell(row, "tool_calls", "view_artifact_id"),
    operationId: nullableTextCell(row, "tool_calls", "operation_id"),
  };
}

/** turn 的工具调用，按创建时间与调用 ID 升序。 */
export function listTurnToolCalls(tx: StorageTransaction, runId: string, turnId: string): readonly ObservedToolCall[] {
  return tx.rows("tool_calls")
    .list({ run_id: runId, turn_id: turnId }, { orderBy: [{ column: "created_at" }, { column: "tool_call_id" }] })
    .map(toolCallOf);
}

/** 分支调度队列：排队为未消费触发与 queued turn 之和，运行中为已领取且未终结的 turn。 */
export function readSchedulerQueue(tx: StorageTransaction, branchId: string): ObservedSchedulerQueue {
  const counts = tx.get(
    `SELECT (SELECT COUNT(*) FROM triggers WHERE branch_id = ? AND consumed_by_turn_id IS NULL) +
            COUNT(CASE WHEN status = 'queued' THEN 1 END) AS queued,
            COUNT(CASE WHEN status IN ('preparing', 'waiting', 'deciding', 'executing', 'speaking', 'settling')
                       THEN 1 END) AS running
       FROM turn_runs WHERE branch_id = ?`,
    [branchId, branchId],
  );
  if (counts === null) throw new DomainError("invalid-state", "调度队列计数缺失");
  return {
    queued: countCell(counts, "turn_runs", "queued"),
    running: countCell(counts, "turn_runs", "running"),
  };
}

/** 分支所属 run 中仍处于 started 的模型尝试创建时间。 */
export function listStartedModelAttemptTimes(tx: StorageTransaction, branchId: string): readonly string[] {
  return tx.all(
    `SELECT m.created_at FROM model_attempts m
       JOIN runs r ON r.run_id = m.run_id
      WHERE r.branch_id = ? AND m.status = 'started'`,
    [branchId],
  ).map((row: StorageRawRow) => textCell(row, "model_attempts", "created_at"));
}
