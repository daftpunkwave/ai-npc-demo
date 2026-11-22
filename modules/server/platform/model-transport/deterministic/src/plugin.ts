/**
 * 按顺序匹配本地模型夹具，生成一次规范化响应或确定性故障。
 * 依赖注入的时间与哈希、配置加载器解析的夹具和已授权的触发主体。
 * 禁止访问网络、读取凭据、重试或更改角色的请求历史。
 */
import {
  canonicalJson, estimateModelInputTokens, estimateTokens,
  type Json, type ModelFixture, type ModelRequest, type ModelTransportError,
  type ModelTransportPort, type ModuleCreateInput,
} from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";

const adapterId = "platform.model-transport.deterministic";
const capabilities = {
  toolCalling: true, strictTools: true, structuredOutput: "json_schema", assistantReplay: "verbatim",
  contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: true, embeddingDimensions: 64,
} as const;

function transportError(kind: ModelTransportError["kind"], retryAfterMs: number | null = null): ModelTransportError {
  return {
    kind, retryAfterMs, retryable: ["rate-limited", "timeout", "network", "server"].includes(kind),
    httpStatus: null, message: `确定性传输：${kind}`,
  };
}

function matches(match: ModelFixture["match"], request: ModelRequest, inputText: string): boolean {
  return match.purpose === request.purpose &&
    (match.agentId === undefined || match.agentId === request.context.agentId) &&
    (match.round === undefined || match.round === request.context.round) &&
    (match.schemaName === undefined || (request.output.kind === "json" && match.schemaName === request.output.schemaName)) &&
    (match.inputIncludes?.every((part) => inputText.includes(part)) ?? true);
}

function defaultResponse(request: ModelRequest): Extract<ModelFixture["response"], { finishReason: string }> {
  if (request.purpose === "decision") {
    const audience = [...new Set(request.context.triggerPrincipalIds)];
    if (audience.length === 0 || audience.length > 4) throw transportError("protocol");
    return { finishReason: "tool_calls", toolCalls: [{
      name: "decision_submit",
      arguments: {
        stance: "none",
        dialogueIntent: { kind: "acknowledge", audience, tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
        noteworthy: [], citedMemoryIds: [], decisionNote: "",
      },
    }] };
  }
  if (request.output.kind === "json") {
    switch (request.output.schemaName) {
      case "speech": return { finishReason: "stop", json: { utterance: "我知道了。", citedRefs: [] } };
      case "reflection": return { finishReason: "stop", json: { reflections: [] } };
      case "daily-review": return { finishReason: "stop", json: { beliefOps: [], currentConcerns: null, intents: [] } };
    }
  }
  throw transportError("protocol");
}

function fixtureCall(call: NonNullable<Extract<ModelFixture["response"], { finishReason: string }>["toolCalls"]>[number], id: string) {
  const argumentsRaw = call.argumentsRaw ?? canonicalJson(call.arguments ?? null);
  try {
    return { id, name: call.name, arguments: JSON.parse(argumentsRaw) as Json, argumentsRaw, parseError: null };
  } catch {
    return { id, name: call.name, arguments: null, argumentsRaw, parseError: "invalid-json" };
  }
}

export function createDeterministicTransport(input: ModuleCreateInput) {
  const port: ModelTransportPort = {
    adapterId,
    capabilities: () => capabilities,
    async complete(request, _credential, connection) {
      const inputText = [request.system, ...request.messages.map((message) =>
        message.role === "assistant" ? canonicalJson(message) : message.content)].join("\n");
      const fixture = connection.fixtures.find(({ match }) => matches(match, request, inputText));
      const response = fixture?.response ?? defaultResponse(request);
      if (response.delayMs !== undefined && response.delayMs > 0) {
        await input.host.sleep(response.delayMs, connection.signal);
      }
      if ("error" in response) throw transportError(response.error.kind, response.error.retryAfterMs ?? null);
      const toolCalls = (response.toolCalls ?? []).map((call, index) => fixtureCall(call, `fixture-${request.context.round}-${index + 1}`));
      const text = response.text ?? null;
      const json = response.json ?? null;
      const usage = response.usage === undefined
        ? {
          inputTokens: estimateModelInputTokens(request),
          outputTokens: estimateTokens(text ?? canonicalJson(toolCalls.length === 0 ? json : toolCalls)),
          cachedInputTokens: null, estimated: true,
        }
        : response.usage ?? { inputTokens: null, outputTokens: null, cachedInputTokens: null, estimated: false };
      return {
        finishReason: response.finishReason, text, json,
        jsonError: response.jsonError ?? null, toolCalls, usage,
        providerReplay: response.providerReplay ?? null,
        servedModel: response.servedModel === undefined ? "deterministic-v1" : response.servedModel,
        providerRequestId: null, fallbackUsed: response.fallbackUsed ?? false,
        wire: {
          requestBody: { system: request.system, messages: request.messages, tools: request.tools, output: request.output },
          responseBody: fixture === undefined ? { text, json, toolCalls } : { fixtureId: fixture.id, ...response },
        },
      };
    },
    async embed({ texts }) {
      return {
        vectors: await Promise.all(texts.map(async (text) =>
          Array.from(await input.host.hash(text), (character) => Number.parseInt(character, 16) / 7.5 - 1))),
        usage: { inputTokens: texts.reduce((sum, text) => sum + estimateTokens(text), 0) },
      };
    },
  };
  return createStatelessModule(input, port);
}
