/**
 * 核心职责：把一批 turn 记录与其触发种类、工具调用数和模型尝试用量汇总为 turn 摘要。
 * 交互契约：在调用方的数据源 read 回调内批量读取关联数据，与 turn 记录处于同一存储快照。
 * 约束与禁忌：不为每个 turn 发起独立查询，不为缺失的模型用量填零。
 */
import { turnSummarySchema, type Json, type TurnSummary } from "@world-prism/contracts";
import type { ObservabilitySourceReader, ObservedTurnRun } from "@world-prism/module-sdk";
import { summaryFromTurnRun } from "./research-codec";

interface KnownTokens {
  readonly input: number;
  readonly output: number;
}

function usageTokens(usage: Json): KnownTokens | null {
  if (usage === null || Array.isArray(usage) || typeof usage !== "object") return null;
  const { inputTokens, outputTokens } = usage;
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  return { input: inputTokens, output: outputTokens };
}

/** 汇总各次尝试的 token；任一次用量未知时总量也未知，而不是把未知当作 0 累加。 */
function totalTokens(usages: readonly Json[]): TurnSummary["tokens"] {
  if (usages.length === 0) return { input: null, output: null };
  let input = 0;
  let output = 0;
  for (const usage of usages) {
    const tokens = usageTokens(usage);
    if (tokens === null) return { input: null, output: null };
    input += tokens.input;
    output += tokens.output;
  }
  return { input, output };
}

export function summarizeTurns(
  reader: ObservabilitySourceReader,
  turns: readonly ObservedTurnRun[],
): readonly TurnSummary[] {
  if (turns.length === 0) return [];
  const turnIds = turns.map((turn) => turn.turnId);
  const usages = reader.turnModelUsages(turnIds);
  const toolCounts = reader.turnToolCallCounts(turnIds);
  const triggers = reader.turnTriggerKinds(turnIds);
  return turns.map((run) => {
    const attempts = usages.get(run.turnId) ?? [];
    return turnSummarySchema.parse(summaryFromTurnRun({
      run,
      triggerKinds: triggers.get(run.turnId) ?? [],
      modelCalls: attempts.length,
      toolCalls: toolCounts.get(run.turnId) ?? 0,
      tokens: totalTokens(attempts),
    }));
  });
}
