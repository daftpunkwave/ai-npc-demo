/**
 * 通过 fetch 向明确配置的兼容端点发起一次对话或向量请求。
 * 支持调用方取消、请求超时及无凭据的回环端点，返回规范化结果或安全错误。
 * 禁止读取环境、追随重定向、发送供应商私有上下文或自行重试。
 */
import { DomainError, jsonValueSchema, type Json, type ModelTransportPort, type ModuleCreateInput } from "@ai-npc/contracts";
import { createStatelessModule, isLoopbackModelEndpoint, modelHttpFailure, modelTransportFailure, parseModelEndpoint } from "@ai-npc/module-sdk";
import { z } from "zod";
import { chatRequest, openAIParameters } from "./chat-request";
import { chatResponse } from "./chat-response";
import { openAICompatibleTransportId } from "./definition";

const embeddingsSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).min(1) })),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().nullish() }).nullish(),
});

function validateEndpoint(endpoint: string | null, hasCredential: boolean): URL {
  const url = endpoint === null ? null : parseModelEndpoint(endpoint);
  if (url === null) throw new DomainError("assembly-incompatible", "OpenAI 兼容连接需要有效的模型端点");
  if (!hasCredential && !isLoopbackModelEndpoint(url)) {
    throw new DomainError("assembly-incompatible", "非回环 OpenAI 兼容端点需要已授权的 API 密钥");
  }
  return url;
}

export function createOpenAICompatibleTransport(input: ModuleCreateInput, fetcher = globalThis.fetch) {
  async function post(url: URL, path: string, body: Json, credential: string | null, timeoutMs: number, signal: AbortSignal): Promise<Json> {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${path}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let raw: unknown;
    try {
      response = await fetcher(url, {
        method: "POST", body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, timeout]),
        headers: { "Content-Type": "application/json", ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }) },
      });
      if (response.ok) raw = await response.json();
    } catch (error) {
      if (timeout.aborted) throw modelTransportFailure("timeout");
      if (error instanceof SyntaxError) throw modelTransportFailure("protocol");
      throw modelTransportFailure("network");
    }
    if (!response.ok) {
      await Promise.allSettled([response.body?.cancel()]);
      throw modelHttpFailure(response.status, response.headers.get("Retry-After"));
    }
    const parsed = jsonValueSchema.safeParse(raw);
    if (!parsed.success) throw modelTransportFailure("protocol");
    return parsed.data;
  }

  const port: ModelTransportPort = {
    adapterId: openAICompatibleTransportId,
    capabilities(parameters, model) {
      if (!openAIParameters.safeParse(parameters).success || model === undefined) {
        throw new DomainError("assembly-incompatible", "OpenAI 兼容模型的 parameters 或 capabilities 无效");
      }
      return model.capabilities;
    },
    validateConnection: validateEndpoint,
    async complete(request, credential, connection) {
      const url = validateEndpoint(connection.endpoint, credential !== null);
      const body = chatRequest(request, connection);
      const reply = await post(url, "chat/completions", body, credential, request.timeoutMs, connection.signal);
      return chatResponse(body, reply, request.output, connection.capabilities?.assistantReplay === "verbatim");
    },
    async embed({ externalModel, texts, timeoutMs }, credential, connection) {
      if (connection?.capabilities?.embedding !== true || texts.length === 0) throw modelTransportFailure("bad-request");
      const url = validateEndpoint(connection.endpoint, credential !== null);
      const body = await post(url, "embeddings", { model: externalModel, input: [...texts] }, credential, timeoutMs, connection.signal);
      const parsed = embeddingsSchema.safeParse(body);
      if (!parsed.success) throw modelTransportFailure("protocol");
      const { data, usage } = parsed.data;
      const ordered = data.sort((left, right) => left.index - right.index);
      const dimensions = connection.capabilities.embeddingDimensions ?? ordered[0]?.embedding.length;
      if (ordered.length !== texts.length || ordered.some((row, index) => row.index !== index || row.embedding.length !== dimensions)) {
        throw modelTransportFailure("protocol");
      }
      return { vectors: ordered.map(({ embedding }) => embedding), usage: { inputTokens: usage?.prompt_tokens ?? null } };
    },
  };
  return createStatelessModule(input, port);
}
