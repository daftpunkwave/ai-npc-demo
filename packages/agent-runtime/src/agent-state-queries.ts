/**
 * 核心职责：为观测数据源提供 Agent 状态的只读查询：激活与控制权、最近 turn 与感知水位、记忆水位与行版本、
 *   观察分页以及未完成的记忆整理任务，并在本文件内把列映射为类型化记录。
 * 交互契约：在调用方事务内按分支读取 agent-runtime 拥有的表；返回记录的字段由观测数据源端口声明，
 *   读取方不需要知道列名与 JSON 存储形态。
 * 约束与禁忌：只读；不执行召回、整理或调度判断；分页与筛选在 SQL 内完成；列不合法时以 invalid-state 失败，
 *   不得用默认值或空数组掩盖损坏的存储行。
 */
import { DomainError, type StorageRawRow, type StorageRow, type StorageTransaction } from "@world-prism/contracts";
import type {
  ObservedMaintenanceTask,
  ObservedMemoryRecord,
  ObservedMemoryWatermark,
  ObservedObservation,
} from "@world-prism/module-sdk";
import {
  countCell,
  finiteCell,
  jsonCell,
  jsonTextCell,
  nullableCountCell,
  nullableTextCell,
  textArrayOf,
  textCell,
} from "./runtime-query-cells";

/** Agent 在分支上的运行时状态；名册种类与位置不归 agent-runtime，由组合方补齐。 */
export interface AgentRuntimeState {
  readonly agentId: string;
  readonly activationStatus: string;
  readonly controllerKind: string | null;
  readonly latestTurnStatus: string | null;
  readonly scannedThroughSeq: number | null;
}

/** 分支内全部已登记激活的 Agent，按 agentId 升序；同一查询内取各自最近一次 turn 状态与感知水位。 */
export function listAgentRuntimeStates(tx: StorageTransaction, branchId: string): readonly AgentRuntimeState[] {
  return tx.all(
    `SELECT a.agent_id, a.status, l.controller_kind,
            (SELECT t.status FROM turn_runs t
              WHERE t.branch_id = a.branch_id AND t.agent_id = a.agent_id
              ORDER BY t.agent_turn_index DESC LIMIT 1) AS turn_status,
            (SELECT p.scanned_through_seq FROM perception_state p
              WHERE p.branch_id = a.branch_id AND p.agent_id = a.agent_id) AS scanned_through_seq
       FROM agent_activations a
       LEFT JOIN controller_leases l
         ON l.branch_id = a.branch_id AND l.agent_id = a.agent_id
      WHERE a.branch_id = ?
      ORDER BY a.agent_id`,
    [branchId],
  ).map((row) => ({
    agentId: textCell(row, "agent_activations", "agent_id"),
    activationStatus: textCell(row, "agent_activations", "status"),
    controllerKind: nullableTextCell(row, "controller_leases", "controller_kind"),
    latestTurnStatus: nullableTextCell(row, "turn_runs", "turn_status"),
    scannedThroughSeq: nullableCountCell(row, "perception_state", "scanned_through_seq"),
  }));
}

/** Agent 的记忆水位；尚未建立时为 null。 */
export function readMemoryWatermark(
  tx: StorageTransaction,
  branchId: string,
  agentId: string,
): ObservedMemoryWatermark | null {
  const row = tx.branch(branchId).table("memory_watermarks").get({ agent_id: agentId });
  if (row === null) return null;
  return {
    revision: countCell(row, "memory_watermarks", "revision"),
    observationSeqConsumed: countCell(row, "memory_watermarks", "observation_seq_consumed"),
    derivedThroughTick: countCell(row, "memory_watermarks", "derived_through_tick"),
  };
}

/** Agent 的感知状态版本；尚未建立时为 null。 */
export function readPerceptionRevision(tx: StorageTransaction, branchId: string, agentId: string): number | null {
  const row = tx.branch(branchId).table("perception_state").get({ agent_id: agentId });
  return row === null ? null : countCell(row, "perception_state", "revision");
}

function memoryRecordOf(row: StorageRow): ObservedMemoryRecord {
  return {
    memoryId: textCell(row, "memory_records", "memory_id"),
    rowVersion: countCell(row, "memory_records", "row_version"),
    kind: textCell(row, "memory_records", "kind"),
    status: textCell(row, "memory_records", "status"),
    epistemic: textCell(row, "memory_records", "epistemic"),
    releasePolicyId: textCell(row, "memory_records", "release_policy_id"),
    validFromTick: countCell(row, "memory_records", "valid_from_tick"),
    validUntilTick: nullableCountCell(row, "memory_records", "valid_until_tick"),
    createdRevision: countCell(row, "memory_records", "created_revision"),
    retiredRevision: nullableCountCell(row, "memory_records", "retired_revision"),
    sourceObservationIds: textArrayOf(
      jsonCell(row, "memory_records", "source_observation_ids_json"),
      "memory_records",
      "source_observation_ids_json",
    ),
    content: jsonCell(row, "memory_records", "content_json"),
  };
}

/** Agent 自身的全部记忆行版本，按 memoryId 与 rowVersion 升序；不合并分支公共记录。 */
export function listMemoryRecordVersions(
  tx: StorageTransaction,
  branchId: string,
  agentId: string,
): readonly ObservedMemoryRecord[] {
  return tx.branch(branchId).table("memory_records")
    .list({ agent_id: agentId }, { orderBy: [{ column: "memory_id" }, { column: "row_version" }] })
    .map(memoryRecordOf);
}

function observationOf(row: StorageRawRow): ObservedObservation {
  const ids = (column: string): readonly string[] =>
    textArrayOf(jsonTextCell(row, "observations", column), "observations", column);
  return {
    observationId: textCell(row, "observations", "observation_id"),
    observationSeq: countCell(row, "observations", "observation_seq"),
    sourceEventIds: ids("source_event_ids_json"),
    sourceObservationIds: ids("source_observation_ids_json"),
    occurredAtTick: countCell(row, "observations", "occurred_at_tick"),
    sensedAtTick: countCell(row, "observations", "sensed_at_tick"),
    knownAtTick: countCell(row, "observations", "known_at_tick"),
    channel: textCell(row, "observations", "channel"),
    epistemic: textCell(row, "observations", "epistemic"),
    confidence: finiteCell(row, "observations", "confidence"),
    releasePolicyId: textCell(row, "observations", "release_policy_id"),
    content: jsonTextCell(row, "observations", "content_json"),
  };
}

/** afterSeq 之后至多 limit 条观察，按 observation_seq 升序。 */
export function listObservationPage(
  tx: StorageTransaction,
  input: { readonly branchId: string; readonly agentId: string; readonly afterSeq: number; readonly limit: number },
): readonly ObservedObservation[] {
  return tx.all(
    `SELECT observation_id, observation_seq, source_event_ids_json, source_observation_ids_json,
            occurred_at_tick, sensed_at_tick, known_at_tick, channel, epistemic,
            confidence, release_policy_id, content_json
       FROM observations
      WHERE branch_id = ? AND agent_id = ? AND observation_seq > ?
      ORDER BY observation_seq ASC LIMIT ?`,
    [input.branchId, input.agentId, input.afterSeq, input.limit],
  ).map(observationOf);
}

/** 分支内排队或已租约、尚未完成的记忆整理任务。 */
export function listPendingMaintenance(tx: StorageTransaction, branchId: string): readonly ObservedMaintenanceTask[] {
  return tx.all(
    `SELECT status, created_at FROM maintenance_runs
      WHERE branch_id = ? AND status IN ('queued', 'leased')`,
    [branchId],
  ).map((row) => {
    const status = row["status"];
    if (status !== "queued" && status !== "leased") {
      throw new DomainError("invalid-state", "存储表 maintenance_runs 的列 status 不在查询集合内");
    }
    return { status, createdAt: textCell(row, "maintenance_runs", "created_at") };
  });
}
