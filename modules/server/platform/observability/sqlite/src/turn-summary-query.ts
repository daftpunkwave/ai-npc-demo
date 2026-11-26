/**
 * 核心职责：批量读取 turn 摘要的触发器、模型尝试与工具调用统计。
 * 交互契约：依赖调用方事务内选中的 turn 行，按其 run 与分支查询关联数据。
 * 约束与禁忌：不为每个 turn 发起独立查询，不为缺失的模型用量填零。
 */
import {
  DomainError,
  turnSummarySchema,
  type StorageRawRow,
  type StorageRow,
  type StorageTransaction,
  type TurnSummary,
} from "@world-prism/contracts";
import { jsonColumn, numberColumn, parseJsonText, stringColumn, summaryFromRow } from "./research-codec";

interface KnownTokens {
  readonly input: number;
  readonly output: number;
}

interface AttemptStats {
  readonly calls: number;
  readonly tokens: KnownTokens | null;
}

function assertTriggerIds(row: StorageRow | StorageRawRow): void {
  const value = row["trigger_ids_json"];
  const ids = typeof value === "string" ? parseJsonText(value) : jsonColumn(value);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new DomainError("invalid-state", "turn trigger_ids_json 不是文本 ID 数组");
  }
}

function attemptTokens(row: StorageRawRow): KnownTokens | null {
  if (row["usage_json"] === null) return null;
  let usage: unknown;
  try {
    usage = JSON.parse(stringColumn(row, "usage_json"));
  } catch (cause) {
    throw new DomainError("invalid-state", "模型尝试的 usage_json 无法解析", { cause });
  }
  if (usage === null || Array.isArray(usage) || typeof usage !== "object") return null;
  const { inputTokens, outputTokens } = usage as { readonly inputTokens?: unknown; readonly outputTokens?: unknown };
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  return { input: inputTokens, output: outputTokens };
}

function summarizeAttempts(rows: readonly StorageRawRow[]): ReadonlyMap<string, AttemptStats> {
  const stats = new Map<string, AttemptStats>();
  for (const row of rows) {
    const turnId = stringColumn(row, "turn_id");
    const previous = stats.get(turnId);
    let tokens = attemptTokens(row);
    if (previous !== undefined) {
      tokens = previous.tokens === null || tokens === null ? null
        : { input: previous.tokens.input + tokens.input, output: previous.tokens.output + tokens.output };
    }
    stats.set(turnId, { calls: (previous?.calls ?? 0) + 1, tokens });
  }
  return stats;
}

export function readTurnSummaries(
  tx: StorageTransaction,
  turns: readonly (StorageRow | StorageRawRow)[],
): readonly TurnSummary[] {
  if (turns.length === 0) return [];
  const turnIds = turns.map((row) => {
    assertTriggerIds(row);
    return stringColumn(row, "turn_id");
  });
  const placeholders = turnIds.map(() => "?").join(", ");
  const attempts = summarizeAttempts(tx.all(
    `SELECT t.turn_id, a.usage_json
       FROM turn_runs t
       JOIN model_attempts a ON a.run_id = t.run_id AND a.work_ref = t.turn_id
      WHERE t.turn_id IN (${placeholders})`,
    turnIds,
  ));
  const toolCounts = new Map(tx.all(
    `SELECT t.turn_id, COUNT(*) AS calls
       FROM turn_runs t
       JOIN tool_calls c ON c.run_id = t.run_id AND c.turn_id = t.turn_id
      WHERE t.turn_id IN (${placeholders})
      GROUP BY t.turn_id`,
    turnIds,
  ).map((row) => [stringColumn(row, "turn_id"), numberColumn(row, "calls")]));
  const triggers = new Map<string, string[]>();
  for (const row of tx.all(
    `SELECT DISTINCT t.turn_id, g.trigger_id, g.kind
       FROM turn_runs t
       JOIN json_each(t.trigger_ids_json) ids
       JOIN triggers g ON g.branch_id = t.branch_id AND g.trigger_id = ids.value
      WHERE t.turn_id IN (${placeholders})
      ORDER BY t.turn_id, g.trigger_id`,
    turnIds,
  )) {
    const turnId = stringColumn(row, "turn_id");
    const kind = stringColumn(row, "kind");
    const list = triggers.get(turnId);
    if (list === undefined) triggers.set(turnId, [kind]);
    else list.push(kind);
  }
  return turns.map((row) => {
    const turnId = stringColumn(row, "turn_id");
    const attempt = attempts.get(turnId);
    return turnSummarySchema.parse(summaryFromRow({
      row,
      triggerKinds: triggers.get(turnId) ?? [],
      modelCalls: attempt?.calls ?? 0,
      toolCalls: toolCounts.get(turnId) ?? 0,
      tokens: attempt?.tokens ?? { input: null, output: null },
    }));
  });
}
