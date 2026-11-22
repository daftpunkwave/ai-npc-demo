/**
 * 校验 OpenAI 兼容返回的线协议结构并规范化首个候选结果。
 * 保留工具参数原文、可用的 token 用量及同供应商回放所需字段。
 * 禁止执行工具或把无效响应当作完整输出。
 */
import { jsonObjectSchema, type Json, type ModelOutput, type ModelResponse } from "@ai-npc/contracts";
import { modelTransportFailure, parseModelJsonOutput } from "@ai-npc/module-sdk";
import { z } from "zod";

const count = z.number().int().nonnegative().nullish();
const toolCallSchema = z.looseObject({
  id: z.string().min(1), type: z.literal("function"),
  function: z.looseObject({ name: z.string().min(1), arguments: z.string() }),
});
const chatResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.looseObject({
      role: z.literal("assistant"), content: z.string().nullable(),
      tool_calls: z.array(toolCallSchema).nullish(), refusal: z.string().nullish(),
    }),
  })).min(1),
  model: z.string().min(1).nullish(), id: z.string().min(1).nullish(),
  usage: z.object({
    prompt_tokens: count, completion_tokens: count, prompt_cache_hit_tokens: count,
    prompt_tokens_details: z.object({ cached_tokens: count }).nullish(),
  }).nullish(),
});

function toolArguments(raw: string): Pick<ModelResponse["toolCalls"][number], "arguments" | "parseError"> {
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { arguments: parsed.data, parseError: null };
  } catch {
    return { arguments: null, parseError: "invalid-json" };
  }
  return { arguments: null, parseError: "invalid-json-object" };
}

function finishReason(reason: string, refusal: string | null | undefined): ModelResponse["finishReason"] {
  if (refusal || reason === "content_filter") return "refusal";
  if (reason === "tool_calls" || reason === "length") return reason;
  return "stop";
}

export function chatResponse(requestBody: Json, responseBody: Json, output: ModelOutput, verbatim: boolean): ModelResponse {
  const parsed = chatResponseSchema.safeParse(responseBody);
  const choice = parsed.success ? parsed.data.choices[0] : undefined;
  if (!parsed.success || choice === undefined) throw modelTransportFailure("protocol");
  const { message } = choice;
  const { usage, model, id } = parsed.data;
  const finish = finishReason(choice.finish_reason, message.refusal);
  const text = finish === "refusal" ? null : message.content;
  const outputJson = output.kind === "json" && finish === "stop"
    ? parseModelJsonOutput(text) : { json: null, jsonError: null };
  const toolCalls = finish === "refusal" ? [] : (message.tool_calls ?? []).map(({ id: callId, function: fn }) => ({
    id: callId, name: fn.name, argumentsRaw: fn.arguments, ...toolArguments(fn.arguments),
  }));
  if (finish === "tool_calls" && toolCalls.length === 0) throw modelTransportFailure("protocol");
  return {
    finishReason: finish, text, ...outputJson, toolCalls,
    providerReplay: verbatim ? jsonObjectSchema.parse(message) : null,
    usage: {
      inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? null, estimated: false,
    },
    servedModel: model ?? null, providerRequestId: id ?? null, fallbackUsed: false,
    wire: { requestBody, responseBody },
  };
}
