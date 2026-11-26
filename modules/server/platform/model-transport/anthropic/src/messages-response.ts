/**
 * 将 Anthropic Messages 的内容、停止原因和用量映射为公共模型响应。
 * 使用 SDK 导出的稳定和 beta 响应类型，保留原始内容与 fallback 计费迭代。
 * 禁止交付已拒绝的输出，或把中途放弃的工具调用交给宿主。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { jsonObjectSchema, jsonValueSchema, type Json, type ModelOutput, type ModelResponse } from "@world-prism/contracts";
import { modelTransportFailure, parseModelJsonOutput } from "@world-prism/module-sdk";

function messageFinish(reason: Anthropic.Message["stop_reason"] | Anthropic.Beta.BetaMessage["stop_reason"]): ModelResponse["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence": return "stop";
    case "tool_use": return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded": return "length";
    case "refusal": return "refusal";
    default: throw modelTransportFailure("protocol");
  }
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function messagesResponse(
  response: Anthropic.Message | Anthropic.Beta.BetaMessage,
  requestBody: Json,
  output: ModelOutput,
): ModelResponse {
  const wire = jsonObjectSchema.safeParse(response);
  if (!wire.success || !Array.isArray(response.content)) throw modelTransportFailure("protocol");
  const finishReason = messageFinish(response.stop_reason);
  const blocks: readonly (Anthropic.ContentBlock | Anthropic.Beta.BetaContentBlock)[] = response.content;
  const boundary = blocks.findLastIndex((block) => block?.type === "fallback");
  const active = finishReason === "refusal" ? [] : blocks.slice(boundary + 1);
  const textBlocks = active.filter((block) => block?.type === "text");
  if (textBlocks.some((block) => typeof block.text !== "string")) throw modelTransportFailure("protocol");
  const text = textBlocks.length === 0 ? null : textBlocks.map((block) => block.text).join("");
  const toolCalls = active.filter((block) => block?.type === "tool_use").map(({ id, name, input }) => {
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") throw modelTransportFailure("protocol");
    const parsed = jsonObjectSchema.safeParse(input);
    return {
      id, name, arguments: parsed.success ? parsed.data : null,
      argumentsRaw: JSON.stringify(input ?? null), parseError: parsed.success ? null : "invalid-json-object",
    };
  });
  if (finishReason === "tool_calls" && toolCalls.length === 0) throw modelTransportFailure("protocol");
  const usage = response.usage;
  const inputTokens = count(usage?.input_tokens);
  const cachedInputTokens = count(usage?.cache_read_input_tokens);
  const iterations = usage !== undefined && usage !== null && "iterations" in usage ? usage.iterations : null;
  return {
    finishReason, text, toolCalls,
    ...(output.kind === "json" && finishReason === "stop" ? parseModelJsonOutput(text) : { json: null, jsonError: null }),
    providerReplay: jsonValueSchema.parse(blocks),
    usage: {
      inputTokens: inputTokens === null ? null : inputTokens + (cachedInputTokens ?? 0) + (count(usage?.cache_creation_input_tokens) ?? 0),
      outputTokens: count(usage?.output_tokens), cachedInputTokens, estimated: false,
    },
    servedModel: typeof response.model === "string" && response.model !== "" ? response.model : null,
    providerRequestId: typeof response.id === "string" && response.id !== "" ? response.id : null,
    fallbackUsed: boundary >= 0 || (Array.isArray(iterations) && iterations.some((item) => item?.type === "fallback_message")),
    wire: { requestBody, responseBody: wire.data },
  };
}
