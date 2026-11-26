/**
 * 使用 Anthropic SDK 发起一次已授权的 Messages 调用。
 * 复用已验证端点和凭据对应的客户端，使用宿主取消信号和请求超时。
 * 禁止 SDK 重试、继承外部认证头、跟随重定向或记录密钥。
 */
import Anthropic from "@anthropic-ai/sdk";
import { DomainError, jsonValueSchema, type ModelTransportPort, type ModuleCreateInput } from "@world-prism/contracts";
import { createStatelessModule, modelBaseUrl, modelHttpFailure, modelTransportFailure, parseModelEndpoint } from "@world-prism/module-sdk";
import { createAnthropicClientCache } from "./client-cache";
import { anthropicTransportId } from "./definition";
import { anthropicParameters, messagesRequest } from "./messages-request";
import { messagesResponse } from "./messages-response";

const defaultBaseUrl = "https://api.anthropic.com";
const supportedModel = "claude-opus-5-5";
const serverFallbackBeta = "server-side-fallback-2026-07-01";

/**
 * 客户端缓存条目上限。
 * 当前 ModelRoute 在 bindRun 时冻结，端点与凭据在一次运行内不变化，缓存通常只命中一个条目；
 * 上限是为将来允许路由热更新时兜底——缓存必须与 StreamHub/SessionRegistry 一样有界，
 * 否则每换一个端点就永久多留一个 SDK 客户端与其连接池。
 */
const maxCachedClients = 16;

function resolveEndpoint(endpoint: string | null, hasCredential: boolean): URL {
  const url = parseModelEndpoint(endpoint ?? defaultBaseUrl);
  if (url === null) throw new DomainError("assembly-incompatible", "Anthropic 连接需要有效的模型端点");
  if (!hasCredential) throw new DomainError("assembly-incompatible", "Anthropic 连接需要已授权的 API 密钥");
  return url;
}

function classify(error: unknown) {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return modelTransportFailure("timeout");
  if (error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.APIUserAbortError) return modelTransportFailure("network");
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    return modelHttpFailure(error.status, error.headers?.get("Retry-After") ?? null);
  }
  return modelTransportFailure("protocol");
}

export function createAnthropicTransport(input: ModuleCreateInput, fetcher = globalThis.fetch) {
  // 键同时包含端点与凭据：任一项变化都必须重建客户端。只按端点做键会让轮换后的凭据复用
  // 旧客户端（携带旧 apiKey），而只按凭据做键会让同一凭据下的多端点互相覆盖。
  const clients = createAnthropicClientCache(maxCachedClients, (baseURL, credential) => new Anthropic({
    apiKey: credential, baseURL, webhookKey: null, maxRetries: 0, logLevel: "off", openTelemetry: false,
    // authorization 显式置 null：SDK 会据此删除该头，凭据只经 x-api-key 传递，
    // 避免默认头把密钥复制到第二个请求头，也避免外部 authorization 被继承。
    defaultHeaders: { authorization: null, "x-api-key": credential },
    fetch: (url, init) => {
      const sdkHeaders = new Headers(init?.headers);
      const headers = new Headers({ "Content-Type": "application/json", "anthropic-version": "2026-10-21", "x-api-key": credential });
      if (sdkHeaders.get("anthropic-beta") === serverFallbackBeta) headers.set("anthropic-beta", serverFallbackBeta);
      return fetcher(url, { ...init, headers, redirect: "error" });
    },
  }));

  function clientFor(endpoint: URL, credential: string): Anthropic {
    return clients.clientFor(modelBaseUrl(endpoint), credential);
  }

  const port: ModelTransportPort = {
    adapterId: anthropicTransportId,
    capabilities(parameters, model) {
      const parsed = anthropicParameters.safeParse(parameters);
      if (!parsed.success || model?.externalModel !== supportedModel) {
        throw new DomainError("assembly-incompatible", "Anthropic 模型或生成参数不受此适配器支持");
      }
      return {
        toolCalling: true, strictTools: parsed.data.strictTools, structuredOutput: "json_schema", assistantReplay: "verbatim",
        contextWindowTokens: 1_000_000, maxOutputTokens: 128_000, embedding: false, embeddingDimensions: null,
      };
    },
    validateConnection: resolveEndpoint,
    async complete(request, credential, connection) {
      if (credential === null) throw modelTransportFailure("auth");
      const parameters = anthropicParameters.safeParse(request.parameters);
      if (!parameters.success || request.externalModel !== supportedModel) throw modelTransportFailure("bad-request");
      const client = clientFor(resolveEndpoint(connection.endpoint, true), credential);
      const params = messagesRequest(request, parameters.data);
      const timeout = AbortSignal.timeout(request.timeoutMs);
      const signal = AbortSignal.any([connection.signal, timeout]);
      const fallback = parameters.data.serverSideFallback === "default";
      const options = { signal, timeout: request.timeoutMs };
      const betaParams = { ...params, fallbacks: "default" as const };
      let response: Anthropic.Message | Anthropic.Beta.BetaMessage;
      try {
        response = fallback
          ? await client.beta.messages.create({ ...betaParams, betas: [serverFallbackBeta] }, options)
          : await client.messages.create({ ...params, messages: params.messages as Anthropic.MessageParam[] }, {
            ...options, headers: { "anthropic-beta": null },
          });
      } catch (error) {
        throw timeout.aborted ? modelTransportFailure("timeout") : classify(error);
      }
      const body = jsonValueSchema.parse(fallback ? betaParams : params);
      return messagesResponse(response, body, request.output);
    },
  };
  return createStatelessModule(input, port);
}
