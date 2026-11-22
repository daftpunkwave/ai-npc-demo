/**
 * 验证 Anthropic SDK 的实际 HTTP 请求、规范化响应与错误分类。
 * 用进程内 fetch 替身演练两轮工具回放、缓存用量与服务端 fallback。
 * 禁止联网、依赖真实认证环境或从模拟响应推断在线模型表现。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicTransportDefinition } from "@ai-npc/mod-platform-model-transport-anthropic/definition";
import type { Json } from "@ai-npc/contracts";
import { modelConnection, modelRequest, statusOutput, transportPort } from "../support/model-transport";

const apiKey = "test-anthropic-key";
const externalModel = "claude-opus-5-5";
const usage = { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 };
const thinking = { type: "thinking", thinking: "encoded context", signature: "signed-block" };
const westTool = { type: "tool_use", id: "toolu-west", name: "read_status", input: { gate: "west" } };
const eastTool = { type: "tool_use", id: "toolu-east", name: "read_status", input: { gate: "east" } };

function messagesReply(content: Json[], stop_reason = "end_turn", overrides: Record<string, Json> = {}) {
  return Response.json({ id: "msg-1", type: "message", role: "assistant", model: externalModel, stop_reason, content, usage, ...overrides });
}

function stubFetch(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Anthropic 模型传输", () => {
  it("原样续传签名块并把并行工具结果合并到一条 user 消息", async () => {
    const initialContent = [thinking, westTool, eastTool];
    const fetcher = stubFetch(messagesReply(initialContent, "tool_use"), messagesReply([{ type: "text", text: "West is ready." }]));
    const port = await transportPort(anthropicTransportDefinition);
    const connection = modelConnection({ endpoint: null });
    const request = modelRequest({ externalModel, parameters: { effort: "low", strictTools: true } });
    const first = await port.complete(request, apiKey, connection);
    const second = await port.complete({ ...request, messages: [
      ...request.messages,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls, providerReplay: first.providerReplay },
      { role: "tool", toolCallId: westTool.id, content: '{"ready":true}', isError: false },
      { role: "tool", toolCallId: eastTool.id, content: '{"error":"unavailable"}', isError: true },
    ] }, apiKey, connection);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(init?.redirect).toBe("error");
    const expected = {
      model: externalModel, max_tokens: 1024, system: request.system, messages: request.messages,
      tools: request.tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema, strict: true })),
      tool_choice: { type: "auto" }, output_config: { effort: "low" }, fallbacks: "default",
    };
    expect(JSON.parse(String(init?.body))).toEqual(expected);
    expect(first.wire.requestBody).toEqual(expected);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ ...expected, messages: [
      ...request.messages, { role: "assistant", content: initialContent }, { role: "user", content: [
        { type: "tool_result", tool_use_id: westTool.id, content: '{"ready":true}', is_error: false },
        { type: "tool_result", tool_use_id: eastTool.id, content: '{"error":"unavailable"}', is_error: true },
      ] },
    ] });
    expect(first).toMatchObject({
      finishReason: "tool_calls", providerReplay: initialContent, providerRequestId: "msg-1",
      toolCalls: [{ id: westTool.id, arguments: { gate: "west" } }, { id: eastTool.id, arguments: { gate: "east" } }],
      usage: { inputTokens: 24, outputTokens: 6, cachedInputTokens: 7, estimated: false },
    });
    expect(second).toMatchObject({ finishReason: "stop", text: "West is ready." });
    expect(JSON.stringify(first.wire)).not.toContain(apiKey);
  });

  it("关闭 fallback 时只用稳定 API 的 JSON schema 并隔离 SDK 环境认证头", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.example.test");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-api-key: ambient-key\nAuthorization: Bearer ambient-token\nx-extra: ambient-header\nanthropic-beta: ambient-beta");
    const fetcher = stubFetch(messagesReply([{ type: "text", text: '{"ready":true}' }]));
    const port = await transportPort(anthropicTransportDefinition);
    const request = modelRequest({ externalModel, purpose: "speech", tools: [], output: statusOutput, parameters: { serverSideFallback: "off" } });
    const response = await port.complete(request, apiKey, modelConnection({ endpoint: null }));
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(apiKey);
    for (const name of ["authorization", "x-extra", "anthropic-beta"]) expect(headers.has(name)).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: externalModel, max_tokens: 1024, system: request.system, messages: request.messages,
      output_config: { effort: "medium", format: { type: "json_schema", schema: statusOutput.schema } },
    });
    expect(response).toMatchObject({ json: { ready: true }, jsonError: null, fallbackUsed: false });
  });

  it("保留全部 fallback 证据并只提交实际服务模型的工具调用", async () => {
    const fallback = { type: "fallback", from: { model: externalModel }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } };
    const partialText = { type: "text", text: "Partial text." };
    const iterations = [{ type: "message", model: externalModel }, { type: "fallback_message", model: "claude-opus-4-8" }];
    const blocks = [thinking, partialText, eastTool, fallback, westTool];
    const fetcher = stubFetch(
      messagesReply(blocks, "tool_use", { model: "claude-opus-4-8", usage: { ...usage, iterations } }),
      messagesReply([{ type: "text", text: "Ready." }], "end_turn", { model: "claude-opus-4-8", usage: { ...usage, iterations: iterations.slice(1) } }),
    );
    const port = await transportPort(anthropicTransportDefinition);
    const request = modelRequest({ externalModel });
    const connection = modelConnection({ endpoint: null });
    const first = await port.complete(request, apiKey, connection);
    expect(first).toMatchObject({ fallbackUsed: true, servedModel: "claude-opus-4-8", providerReplay: blocks });
    expect(first.toolCalls.map(({ id }) => id)).toEqual([westTool.id]);
    expect(first.wire.responseBody).toMatchObject({ usage: { iterations }, content: blocks });
    const second = await port.complete({ ...request, messages: [
      ...request.messages,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls, providerReplay: first.providerReplay },
      { role: "tool", toolCallId: westTool.id, content: '{"ready":true}', isError: false },
    ] }, apiKey, connection);
    expect(second.fallbackUsed).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ messages: [
      ...request.messages, { role: "assistant", content: [partialText, fallback, westTool] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: westTool.id }] },
    ] });
  });

  it.each([
    [400, "bad-request", false], [422, "bad-request", false], [401, "auth", false], [403, "auth", false],
    [404, "not-found", false], [408, "rate-limited", true], [409, "rate-limited", true], [429, "rate-limited", true],
    [500, "server", true], [529, "server", true],
  ])("用 SDK 异常分类 HTTP %i 为 %s 且不重试", async (status, kind, retryable) => {
    const fetcher = stubFetch(Response.json({ error: { message: apiKey } }, { status, headers: { "retry-after": "3" } }));
    const port = await transportPort(anthropicTransportDefinition);
    await expect(port.complete(modelRequest({ externalModel }), apiKey, modelConnection({ endpoint: null }))).rejects.toMatchObject({
      kind, retryable, httpStatus: status, retryAfterMs: kind === "rate-limited" ? 3000 : null,
      message: `模型传输失败：${kind}`,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("按停止原因拒绝无完整结果的返回", async () => {
    stubFetch(
      messagesReply([], "refusal"), messagesReply([{ type: "text", text: '{"ready":' }], "max_tokens"), messagesReply([], "pause_turn"),
    );
    const port = await transportPort(anthropicTransportDefinition);
    const request = modelRequest({ externalModel, tools: [], output: statusOutput });
    const connection = modelConnection({ endpoint: null });
    await expect(port.complete(request, apiKey, connection)).resolves.toMatchObject({ finishReason: "refusal", text: null, json: null });
    await expect(port.complete(request, apiKey, connection)).resolves.toMatchObject({ finishReason: "length", json: null });
    await expect(port.complete(request, apiKey, connection)).rejects.toMatchObject({ kind: "protocol", retryable: false });
  });
});
