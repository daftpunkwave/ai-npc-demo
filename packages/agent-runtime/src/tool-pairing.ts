/**
 * 核心职责：校验模型工具调用与结果一一配对，并生成同 callId 的 tool 消息。
 * 交互契约：每个 NormalizedToolCall 必须恰好对应一个 ToolCallOutcome。
 * 约束与禁忌：不得补齐伪造结果、重排调用或把另一调用的结果顶替进来。
 */
import type { NormalizedMessage, NormalizedToolCall } from "@ai-npc/contracts";

export interface PairedToolOutcome {
  readonly providerCallId: string;
  readonly modelText: string;
  readonly isError: boolean;
}

export function assertToolCallResultPairing(
  calls: readonly NormalizedToolCall[],
  outcomes: readonly PairedToolOutcome[],
): void {
  const callIds = calls.map((call) => call.id);
  if (new Set(callIds).size !== callIds.length) throw new Error("tool calls contain duplicate provider call IDs");
  const outcomeById = new Map<string, PairedToolOutcome>();
  for (const outcome of outcomes) {
    if (outcomeById.has(outcome.providerCallId)) {
      throw new Error(`tool call ${outcome.providerCallId} has more than one result`);
    }
    outcomeById.set(outcome.providerCallId, outcome);
  }
  for (const callId of callIds) {
    if (!outcomeById.has(callId)) throw new Error(`tool call ${callId} has no result`);
  }
  for (const outcome of outcomes) {
    if (!callIds.includes(outcome.providerCallId)) {
      throw new Error(`tool result ${outcome.providerCallId} has no matching call`);
    }
  }
}

export function pairedToolMessages(
  calls: readonly NormalizedToolCall[],
  outcomes: readonly PairedToolOutcome[],
): readonly NormalizedMessage[] {
  assertToolCallResultPairing(calls, outcomes);
  const byId = new Map(outcomes.map((outcome) => [outcome.providerCallId, outcome]));
  return calls.map((call) => {
    const outcome = byId.get(call.id);
    if (outcome === undefined) throw new Error(`tool call ${call.id} has no result`);
    return {
      role: "tool",
      toolCallId: call.id,
      content: outcome.modelText,
      isError: outcome.isError,
    };
  });
}