/**
 * 验证 OpenAI 兼容适配器的请求、回放、输出和失败语义。
 * 通过已登记的模型端口调用，用 fetch 替身记录实际发生的请求。
 * 禁止绑定监听端口、使用真实凭据或发送网络流量。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAICompatibleTransportDefinition } from "@world-prism/mod-platform-model-transport-openai-compatible/definition";
import type { Json } from "@world-prism/contracts";
import { modelConnection, modelRequest, statusOutput, transportPort } from "../support/model-transport";

const credential = "contract-test-key";
/** 模型池绑定 run 时交给 `capabilities` 预检的挂载模型。 */
const mountedModel = {
  externalModel: "test-chat",
  capabilities: {
    toolCalling: true, strictTools: false, structuredOutput: "json_object", assistantReplay: "standard",
    contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null,
  },
} as const;

function completion(message: Json, finish = "stop") {
  return { id: "chat-1", model: "test-chat", choices: [{ finish_reason: finish, message }] };
}

function fetchReply(response: Response) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI 兼容模型传输", () => {
  it.each(["standard", "verbatim"] as const)("按 %s 重放 assistant 并发送原始工具参数", async (assistantReplay) => {
    const call = { id: "call-1", type: "function", index: 0, function: { name: "read_status", arguments: '{ "gate": "west" }' } };
    const assistant = { role: "assistant", content: null, reasoning_content: "private reasoning", tool_calls: [call] };
    const reply = { ...completion(assistant, "tool_calls"), usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } };
    const fetcher = fetchReply(Response.json(reply));
    fetcher.mockResolvedValueOnce(Response.json(reply));
    const port = await transportPort(openAICompatibleTransportDefinition);
    const connection = modelConnection({}, { strictTools: true, assistantReplay });
    const request = modelRequest({ parameters: { temperature: 0.25, maxTokensField: "max_completion_tokens" } });
    const first = await port.complete(request, credential, connection);
    expect(first).toMatchObject({
      finishReason: "tool_calls", toolCalls: [{ id: call.id, arguments: { gate: "west" }, argumentsRaw: call.function.arguments }],
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3, estimated: false },
      providerReplay: assistantReplay === "verbatim" ? assistant : null,
    });
    await port.complete({ ...request, messages: [
      ...request.messages,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls, providerReplay: first.providerReplay },
      { role: "tool", toolCallId: call.id, content: '{"ready":true}', isError: false },
    ] }, credential, connection);
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(String(url)).toBe("https://model.example.test/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${credential}` } });
    const expectedAssistant = assistantReplay === "verbatim" ? assistant : {
      role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: call.function }],
    };
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "test-chat", messages: [
        { role: "system", content: request.system }, ...request.messages, expectedAssistant,
        { role: "tool", tool_call_id: call.id, content: '{"ready":true}' },
      ],
      tools: [{ type: "function", function: {
        name: "read_status", description: request.tools[0]?.description, parameters: request.tools[0]?.inputSchema, strict: true,
      } }], tool_choice: "auto", temperature: 0.25, max_completion_tokens: 1024, stream: false,
    });
    expect(JSON.stringify(first.wire)).not.toContain(credential);
  });

  it.each(["json_schema", "json_object", "none"] as const)("按 %s 能力发送结构化输出请求", async (structuredOutput) => {
    const content = '```json\n{"ready":true,"label":"{quoted} and \\"escape\\""}\n```';
    const fetcher = fetchReply(Response.json(completion({ role: "assistant", content })));
    const port = await transportPort(openAICompatibleTransportDefinition);
    const connection = modelConnection({}, { structuredOutput });
    const request = modelRequest({ purpose: "speech", tools: [], output: statusOutput });
    const response = await port.complete(request, credential, connection);
    const system = structuredOutput === "json_schema" ? request.system
      : `${request.system}\n${connection.jsonOutputSuffix}\n${JSON.stringify(statusOutput.schema)}`;
    const responseFormat = structuredOutput === "json_schema"
      ? { type: "json_schema", json_schema: { name: "status", schema: statusOutput.schema, strict: true } }
      : { type: "json_object" };
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      model: "test-chat", messages: [{ role: "system", content: system }, ...request.messages], max_tokens: 1024, stream: false,
      ...(structuredOutput === "none" ? {} : { response_format: responseFormat }),
    });
    expect(response).toMatchObject({ json: { ready: true, label: '{quoted} and "escape"' }, jsonError: null, usage: { inputTokens: null } });
  });

  it.each([
    ["未声明", {}, undefined],
    ["disabled", { thinking: "disabled" }, { type: "disabled" }],
    ["enabled", { thinking: "enabled" }, { type: "enabled" }],
  ] as const)("推理开关%s时按 DeepSeek 兼容格式映射 thinking 字段", async (_label, parameters, wire) => {
    const fetcher = fetchReply(Response.json(completion({ role: "assistant", content: '{"ready":true}' })));
    const port = await transportPort(openAICompatibleTransportDefinition);
    expect(port.capabilities(parameters, mountedModel)).toEqual(mountedModel.capabilities);
    const request = modelRequest({ purpose: "speech", tools: [], output: statusOutput, parameters, maxOutputTokens: 400 });
    await port.complete(request, credential, modelConnection());
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(Object.hasOwn(body, "thinking")).toBe(wire !== undefined);
    expect(body["thinking"]).toEqual(wire);
    expect(body).toMatchObject({ max_tokens: 400, response_format: { type: "json_object" }, stream: false });
  });

  it.each([
    ["未知线协议参数", { reasoning_effort: "minimal" }],
    ["顶层透传的 enable_thinking", { enable_thinking: false }],
    ["thinking 的非法取值", { thinking: "minimal" }],
    ["thinking 写成线协议对象", { thinking: { type: "disabled" } }],
  ])("参数校验拒绝%s，预检与发送前都不放行", async (_label, parameters) => {
    const fetcher = fetchReply(Response.json(completion({ role: "assistant", content: "unused" })));
    const port = await transportPort(openAICompatibleTransportDefinition);
    expect(() => port.capabilities(parameters, mountedModel)).toThrow("OpenAI 兼容模型的 parameters 或 capabilities 无效");
    await expect(port.complete(modelRequest({ parameters }), credential, modelConnection()))
      .rejects.toMatchObject({ kind: "bad-request", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [400, "bad-request", false], [422, "bad-request", false], [401, "auth", false], [403, "auth", false],
    [404, "not-found", false], [408, "rate-limited", true], [409, "rate-limited", true], [429, "rate-limited", true],
    [502, "server", true],
  ])("将 HTTP %i 分类为 %s 并只尝试一次", async (status, kind, retryable) => {
    const fetcher = fetchReply(new Response(credential, { status, headers: { "retry-after": "1.5" } }));
    const port = await transportPort(openAICompatibleTransportDefinition);
    await expect(port.complete(modelRequest(), credential, modelConnection())).rejects.toMatchObject({
      kind, retryable, httpStatus: status, retryAfterMs: kind === "rate-limited" ? 1500 : null,
      message: `模型传输失败：${kind}`,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["not json", '{"choices":[]}'])("拒绝无可用候选的响应 %s", async (body) => {
    fetchReply(new Response(body));
    const port = await transportPort(openAICompatibleTransportDefinition);
    await expect(port.complete(modelRequest(), credential, modelConnection())).rejects.toMatchObject({ kind: "protocol", retryable: false });
  });

  it("保留截断与拒绝的停止原因，无效 JSON 不产生输出对象", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(completion({ role: "assistant", content: '{"ready":' }, "length")))
      .mockResolvedValueOnce(Response.json(completion({ role: "assistant", content: '{"ready":true}', refusal: "declined" })))
      .mockResolvedValueOnce(Response.json(completion({ role: "assistant", content: '{"ready":}' })));
    vi.stubGlobal("fetch", fetcher);
    const port = await transportPort(openAICompatibleTransportDefinition);
    const request = modelRequest({ tools: [], output: statusOutput });
    const connection = modelConnection();
    await expect(port.complete(request, credential, connection)).resolves.toMatchObject({ finishReason: "length", json: null });
    await expect(port.complete(request, credential, connection)).resolves.toMatchObject({ finishReason: "refusal", text: null, json: null });
    await expect(port.complete(request, credential, connection)).resolves.toMatchObject({ finishReason: "stop", jsonError: "invalid-json" });
  });

  it("取消在途请求并区分本次请求超时", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const port = await transportPort(openAICompatibleTransportDefinition);
    const controller = new AbortController();
    const cancelled = port.complete(modelRequest(), credential, modelConnection({ signal: controller.signal }));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "network" });
    await expect(port.complete(modelRequest({ timeoutMs: 10 }), credential, modelConnection())).rejects.toMatchObject({ kind: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("回环向量请求无凭据头并按输入顺序还原向量", async () => {
    const fetcher = fetchReply(Response.json({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 7 } }));
    const port = await transportPort(openAICompatibleTransportDefinition);
    const connection = modelConnection({ endpoint: "http://127.0.0.1:11434/v1" }, { embedding: true, embeddingDimensions: 2 });
    await expect(port.embed?.({ externalModel: "embed", texts: ["a", "b"], timeoutMs: 500 }, null, connection))
      .resolves.toEqual({ vectors: [[1, 2], [3, 4]], usage: { inputTokens: 7 } });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({ model: "embed", input: ["a", "b"] });
  });
});
