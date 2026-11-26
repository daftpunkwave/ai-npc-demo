/**
 * 将规范化工具、对话和输出格式映射为 Anthropic Messages 请求。
 * 接收同适配器签名回放块，合并连续工具结果，并保留 fallback 边界。
 * 禁止改变签名块内容、重排工具历史或增加供应商侧执行的工具。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { jsonObjectSchema, type Json, type ModelRequest, type NormalizedMessage } from "@world-prism/contracts";
import { modelTransportFailure } from "@world-prism/module-sdk";
import { z } from "zod";

export const anthropicParameters = z.object({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  serverSideFallback: z.enum(["off", "default"]).default("default"),
  strictTools: z.boolean().default(false),
}).strict();

type AssistantBlock = Anthropic.TextBlockParam | Anthropic.ThinkingBlockParam |
  Anthropic.RedactedThinkingBlockParam | Anthropic.ToolUseBlockParam | Anthropic.Beta.BetaFallbackBlockParam;

function replayBlocks(replay: Json, fallback: boolean): AssistantBlock[] {
  if (!Array.isArray(replay)) throw modelTransportFailure("bad-request");
  const blocks = replay.map((block) => {
    const parsed = jsonObjectSchema.safeParse(block);
    if (!parsed.success) throw modelTransportFailure("bad-request");
    return parsed.data;
  });
  const boundary = blocks.findLastIndex((block) => block["type"] === "fallback");
  return blocks.flatMap((block, index) => {
    const type = block["type"];
    if (index < boundary && type !== "text" && type !== "fallback") return [];
    if (type === "text" || type === "thinking" || type === "redacted_thinking" || type === "tool_use" || (type === "fallback" && fallback)) {
      return [block as unknown as AssistantBlock];
    }
    throw modelTransportFailure("bad-request");
  });
}

function messagesFor(messages: readonly NormalizedMessage[], fallback: boolean): Anthropic.Beta.BetaMessageParam[] {
  const mapped: Anthropic.Beta.BetaMessageParam[] = [];
  let toolResults: Anthropic.ToolResultBlockParam[] | null = null;
  for (const message of messages) {
    if (message.role === "tool") {
      if (toolResults === null) {
        toolResults = [];
        mapped.push({ role: "user", content: toolResults });
      }
      toolResults.push({ type: "tool_result", tool_use_id: message.toolCallId, content: message.content, is_error: message.isError });
      continue;
    }
    toolResults = null;
    if (message.role === "user") {
      mapped.push({ role: "user", content: message.content });
      continue;
    }
    const content: AssistantBlock[] = message.providerReplay === null
      ? [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...message.toolCalls.map(({ id, name, arguments: input }) => ({ type: "tool_use" as const, id, name, input })),
      ]
      : replayBlocks(message.providerReplay, fallback);
    mapped.push({ role: "assistant", content });
  }
  return mapped;
}

export function messagesRequest(request: ModelRequest, parameters: z.infer<typeof anthropicParameters>) {
  if (request.tools.length > 0 && request.output.kind === "json") throw modelTransportFailure("bad-request");
  const outputConfig: Anthropic.OutputConfig = { effort: parameters.effort };
  if (request.output.kind === "json") {
    const parsed = jsonObjectSchema.safeParse(request.output.schema);
    if (!parsed.success) throw modelTransportFailure("bad-request");
    outputConfig.format = { type: "json_schema", schema: parsed.data };
  }
  const tools: Anthropic.Tool[] = request.tools.map(({ name, description, inputSchema }) => {
    const parsed = jsonObjectSchema.safeParse(inputSchema);
    if (!parsed.success || parsed.data["type"] !== "object") throw modelTransportFailure("bad-request");
    return {
      name, description, input_schema: { ...parsed.data, type: "object" },
      ...(parameters.strictTools ? { strict: true } : {}),
    };
  });
  const fallback = parameters.serverSideFallback === "default";
  return {
    model: request.externalModel, max_tokens: request.maxOutputTokens, system: request.system,
    messages: messagesFor(request.messages, fallback), output_config: outputConfig,
    ...(tools.length === 0 ? {} : { tools, tool_choice: { type: "auto" as const } }),
  };
}
