/**
 * 核心职责：读写探针结果归档 `probe_results`，并读出沙盒里探针 turn 的终态，供 turn 管线与实验执行器共用同一份字段映射。
 * 交互契约：全部函数在调用方事务内执行；有效性与无效原因在写入时一次判定，读取方直接采用归档结论。
 * 约束与禁忌：只追加或把已有记录改判为无效，不删除结果、不改写回答正文；无效原因只取评估契约登记的取值。
 */
import type { Json, ReportProbeInvalidReason as ProbeInvalidReason, StorageTransaction } from "@world-prism/contracts";
import { nullableTextCell, textCell } from "./runtime-query-cells";

/** 一条待写入的探针结果；`invalidReason` 为 null 表示有效样本，取值与评估报告 `invalidProbeCounts` 的键一致。 */
export interface ProbeResultInput {
  readonly probeResultId: string;
  readonly runId: string;
  readonly scriptId: string;
  readonly probeId: string;
  readonly agentId: string;
  readonly askedAtTick: number;
  readonly answerText: string | null;
  readonly decision: Json | null;
  readonly invalidReason: ProbeInvalidReason | null;
  readonly createdAt: string;
}

/** 已归档探针结果的判定字段。 */
export interface ProbeResultRecord {
  readonly probeResultId: string;
  readonly valid: boolean;
  readonly invalidReason: string | null;
}

/** 沙盒内某个 Agent 最近一次 turn 的终态。 */
export interface ProbeTurnOutcome {
  readonly turnId: string;
  readonly status: string;
  readonly terminalReason: string | null;
}

/** 写入一条探针结果；有效性随无效原因一次落定，计分时不再按回答文本重推。 */
export function insertProbeResult(tx: StorageTransaction, input: ProbeResultInput): void {
  tx.rows("probe_results").put({
    probe_result_id: input.probeResultId,
    run_id: input.runId,
    script_id: input.scriptId,
    probe_id: input.probeId,
    agent_id: input.agentId,
    asked_at_tick: input.askedAtTick,
    answer_text: input.answerText,
    decision_json: input.decision,
    score_json: null,
    valid: input.invalidReason === null ? 1 : 0,
    invalid_reason: input.invalidReason,
    created_at: input.createdAt,
  });
}

/** 读取某个 run 内某条探针最早写入的结果；没有记录时为 null。 */
export function readProbeResult(tx: StorageTransaction, runId: string, probeId: string): ProbeResultRecord | null {
  const [row] = tx.rows("probe_results").list(
    { run_id: runId, probe_id: probeId },
    { orderBy: [{ column: "created_at" }, { column: "probe_result_id" }], limit: 1 },
  );
  if (row === undefined) return null;
  return {
    probeResultId: textCell(row, "probe_results", "probe_result_id"),
    valid: row["valid"] === 1,
    invalidReason: nullableTextCell(row, "probe_results", "invalid_reason"),
  };
}

/**
 * 把已写入的结果改判为无效。
 * 对白在 speaking 阶段写入后，turn 仍可能在结算阶段失败；此时回答不能算作完整 turn 的产物。
 */
export function invalidateProbeResult(tx: StorageTransaction, probeResultId: string, reason: ProbeInvalidReason): void {
  const table = tx.rows("probe_results");
  const row = table.get({ probe_result_id: probeResultId });
  if (row === null) return;
  table.put({ ...row, valid: 0, invalid_reason: reason });
}

/** 某个 run 已经写入结果的探针 ID。 */
export function recordedProbeIds(tx: StorageTransaction, runId: string): ReadonlySet<string> {
  return new Set(tx.rows("probe_results").list({ run_id: runId }).map((row) => textCell(row, "probe_results", "probe_id")));
}

/** 读取分支内某个 Agent 最近一次 turn 的终态；沙盒只调度探针 turn，因此它就是该探针的 turn。 */
export function readLatestTurnOutcome(tx: StorageTransaction, branchId: string, agentId: string): ProbeTurnOutcome | null {
  const row = tx.get(
    `SELECT turn_id, status, terminal_reason FROM turn_runs
      WHERE branch_id = ? AND agent_id = ?
      ORDER BY agent_turn_index DESC LIMIT 1`,
    [branchId, agentId],
  );
  if (row === null) return null;
  return {
    turnId: textCell(row, "turn_runs", "turn_id"),
    status: textCell(row, "turn_runs", "status"),
    terminalReason: nullableTextCell(row, "turn_runs", "terminal_reason"),
  };
}
