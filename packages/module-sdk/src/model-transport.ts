/**
 * 提供模型传输共用的 HTTP 错误分类、端点约束和 JSON 输出解析。
 * 输入为规范化模型契约、HTTP 元数据或模型返回的文本。
 * 错误字段仅使用固定消息，禁止保留供应商错误正文、地址或密钥。
 */
import { jsonObjectSchema, type ModelResponse, type ModelTransportError, type ModelTransportErrorKind } from "@world-prism/contracts";

export function isRetryableModelError(kind: ModelTransportErrorKind): boolean {
  return kind === "rate-limited" || kind === "timeout" || kind === "network" || kind === "server";
}

export function modelTransportFailure(
  kind: ModelTransportErrorKind,
  httpStatus: number | null = null,
  retryAfterMs: number | null = null,
): ModelTransportError {
  return { kind, httpStatus, retryAfterMs, retryable: isRetryableModelError(kind), message: `模型传输失败：${kind}` };
}

export function modelHttpFailure(status: number, retryAfter: string | null): ModelTransportError {
  if (status === 400 || status === 422) return modelTransportFailure("bad-request", status);
  if (status === 401 || status === 403) return modelTransportFailure("auth", status);
  if (status === 404) return modelTransportFailure("not-found", status);
  if (status === 408 || status === 409 || status === 429) {
    const milliseconds = retryAfter === null || retryAfter.trim() === "" ? Number.NaN : Math.ceil(Number(retryAfter) * 1_000);
    return modelTransportFailure("rate-limited", status, Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null);
  }
  return modelTransportFailure(status >= 500 ? "server" : "protocol", status);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function modelBaseUrl(endpoint: URL): string {
  return trimTrailingSlashes(endpoint.href);
}

export function modelEndpointUrl(endpoint: URL, path: string): URL {
  const url = new URL(endpoint.href);
  url.pathname = `${trimTrailingSlashes(url.pathname)}/${path}`;
  return url;
}

export function isLoopbackModelEndpoint(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
}

export function parseModelEndpoint(endpoint: string): URL | null {
  const url = URL.parse(endpoint);
  if (url === null || url.username || url.password || url.href.includes("?") || url.href.includes("#")) return null;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackModelEndpoint(url)) ? url : null;
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === "\\") { index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function parseModelJsonOutput(text: string | null): Pick<ModelResponse, "json" | "jsonError"> {
  const object = text === null ? null : firstJsonObject(text);
  if (object === null) return { json: null, jsonError: "missing-json-object" };
  try {
    const parsed = jsonObjectSchema.safeParse(JSON.parse(object));
    return parsed.success ? { json: parsed.data, jsonError: null } : { json: null, jsonError: "invalid-json" };
  } catch {
    return { json: null, jsonError: "invalid-json" };
  }
}
