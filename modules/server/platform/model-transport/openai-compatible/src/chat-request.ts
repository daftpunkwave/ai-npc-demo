/**
 * 将规范化对话、工具和结构化输出映射为 Chat Completions 请求。
 * 模型布局给出能力与参数，内容包提供弱结构化模式的 JSON 提示语。
 * 禁止注入任意线协议参数，或把连接凭据与宿主上下文写入请求体。
 */
import { jsonObjectSchema, type Json, type ModelCapabilities, type ModelConnectionInput, type ModelRequest, type NormalizedMessage } from "@ai-npc/contracts";
import { modelTransportFailure } from "@ai-npc/module-sdk";
import { z } from "zod";

export const openAIParameters = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
}).strict();

function toChatMessage(message: NormalizedMessage, replay: ModelCapabilities["assistantReplay"]): Json {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (replay === "verbatim" && message.providerReplay !== null) {
    const parsed = jsonObjectSchema.safeParse(message.providerReplay);
    if (!parsed.success || parsed.data["role"] !== "assistant") throw modelTransportFailure("bad-request");
    return parsed.data;
  }
  return {
    role: "assistant", content: message.content,
    ...(message.toolCalls.length === 0 ? {} : {
      tool_calls: message.toolCalls.map(({ id, name, argumentsRaw }) => ({
        id, type: "function", function: { name, arguments: argumentsRaw },
      })),
    }),
  };
}

export function chatRequest(request: ModelRequest, connection: ModelConnectionInput): Json {
  const { capabilities, jsonOutputSuffix } = connection;
  const parameters = openAIParameters.safeParse(request.parameters);
  if (!parameters.success || capabilities === undefined) throw modelTransportFailure("bad-request");
  if (request.tools.length > 0 && (request.output.kind !== "text" || !capabilities.toolCalling)) {
    throw modelTransportFailure("bad-request");
  }
  let system = request.system;
  let responseFormat: Json | undefined;
  if (request.output.kind === "json") {
    if (capabilities.structuredOutput === "json_schema") {
      responseFormat = { type: "json_schema", json_schema: { name: request.output.schemaName, schema: request.output.schema, strict: true } };
    } else {
      if (jsonOutputSuffix === undefined || jsonOutputSuffix.trim() === "") throw modelTransportFailure("bad-request");
      system = `${system}\n${jsonOutputSuffix}\n${JSON.stringify(request.output.schema)}`;
      if (capabilities.structuredOutput === "json_object") responseFormat = { type: "json_object" };
    }
  }
  return {
    model: request.externalModel,
    messages: [{ role: "system", content: system }, ...request.messages.map((message) => toChatMessage(message, capabilities.assistantReplay))],
    ...(request.tools.length === 0 ? {} : {
      tools: request.tools.map(({ name, description, inputSchema }) => ({
        type: "function", function: { name, description, parameters: inputSchema, ...(capabilities.strictTools ? { strict: true } : {}) },
      })),
      tool_choice: "auto",
    }),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    ...(parameters.data.temperature === undefined ? {} : { temperature: parameters.data.temperature }),
    [parameters.data.maxTokensField]: request.maxOutputTokens,
    stream: false,
  };
}
