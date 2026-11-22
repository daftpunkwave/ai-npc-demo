/**
 * 验证确定性模型传输的夹具匹配顺序、默认响应边界与故障注入语义。
 * 通过已登记的模块描述符创建传输端口，用规范请求构造多主体触发场景。
 * 禁止访问网络、读取真实夹具文件或依赖宿主持久化状态。
 */
import { describe, expect, it } from "vitest";
import { deterministicModelTransportDefinition } from "@ai-npc/mod-platform-model-transport-deterministic/definition";
import type { HostServices, ModelConnectionInput, ModelFixture, ModelRequest, ModelTransportPort } from "@ai-npc/contracts";
import { modelRequest, statusOutput } from "../support/model-transport";

const principalIds = ["player-1", "human-independent", "human-earth-alliance", "human-pacifist", "human-alien-accord"];

function fixture(id: string, match: Partial<ModelFixture["match"]> & Pick<ModelFixture["match"], "purpose">, response: ModelFixture["response"]): ModelFixture {
  return { id, match, response };
}

type SuccessResponse = Extract<ModelFixture["response"], { finishReason: string }>;

function decisionFixture(id: string, match: Partial<ModelFixture["match"]> & Pick<ModelFixture["match"], "purpose">): ModelFixture & {
  response: SuccessResponse;
} {
  return { id, match, response: {
    finishReason: "tool_calls",
    toolCalls: [{ name: "decision_submit", arguments: {
      stance: "none",
      dialogueIntent: { kind: "acknowledge", audience: principalIds, tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
      noteworthy: [], citedMemoryIds: [], decisionNote: `fixture:${id}`,
    } }],
  } } as ModelFixture & { response: SuccessResponse };
}

function connection(fixtures: readonly ModelFixture[]): ModelConnectionInput {
  return {
    endpoint: null, fixtures, signal: new AbortController().signal,
    capabilities: {
      toolCalling: true, strictTools: true, structuredOutput: "json_schema", assistantReplay: "verbatim",
      contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: true, embeddingDimensions: 64,
    },
  };
}

async function portWith(host: Partial<HostServices> = {}): Promise<ModelTransportPort> {
  const instance = await deterministicModelTransportDefinition.create({
    moduleId: deterministicModelTransportDefinition.id, realm: "server", config: {}, scope: {}, ports: {},
    host: new Proxy({} as HostServices, {
      get: (_target, key) => {
        if (key in host) return host[key as keyof typeof host];
        throw new Error("Transport requested an unexpected host service");
      },
    }),
    signal: new AbortController().signal,
  });
  return instance.port as ModelTransportPort;
}

describe("确定性模型传输", () => {
  it("按文件顺序取第一个命中的夹具，后续同条件夹具不再生效", async () => {
    const port = await portWith();
    const first = decisionFixture("first-match", { purpose: "decision" });
    const second = decisionFixture("second-match", { purpose: "decision" });
    const result = await port.complete(modelRequest({ context: { workRef: "model-test", agentId: null, evaluatorId: null, round: 1, triggerPrincipalIds: [] } }), null, connection([first, second]));
    expect(result.wire.responseBody).toMatchObject({ fixtureId: "first-match" });
    expect(result.toolCalls[0]?.arguments).toMatchObject({ decisionNote: "fixture:first-match" });
  });

  it("全部匹配条件同时满足才命中，triggerPrincipalCount 按请求主体数精确匹配", async () => {
    const port = await portWith();
    const scoped = decisionFixture("scoped", {
      purpose: "decision", agentId: "human-independent", round: 2, triggerPrincipalCount: 5,
      inputIncludes: ["护送"],
    });
    const request = modelRequest({
      system: "决策请求处理",
      context: { workRef: "model-test", agentId: "human-independent", evaluatorId: null, round: 2, triggerPrincipalIds: principalIds },
    });
    const matched = await port.complete({ ...request, messages: [{ role: "user", content: "请护送物资" }] }, null, connection([scoped]));
    expect(matched.wire.responseBody).toMatchObject({ fixtureId: "scoped" });
    // 只把 round 改成不匹配，其余条件（agentId、主体数、inputIncludes）仍满足，单独验证 round。
    await expect(port.complete(
      { ...request, messages: [{ role: "user", content: "请护送物资" }], context: { ...request.context, round: 1 } },
      null, connection([scoped]),
    )).rejects.toMatchObject({ kind: "protocol" });
  });

  it("默认 decision 响应对 1–4 个去重主体返回一次 decision_submit，受众为主体全集", async () => {
    const port = await portWith();
    const fourPrincipals = principalIds.slice(0, 4);
    const result = await port.complete(
      modelRequest({ context: { workRef: "model-test", agentId: "human-independent", evaluatorId: null, round: 1, triggerPrincipalIds: fourPrincipals } }),
      null, connection([]),
    );
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "decision_submit" });
    expect(result.toolCalls[0]?.arguments).toMatchObject({
      stance: "none",
      dialogueIntent: { kind: "acknowledge", audience: fourPrincipals, tone: "neutral", reasonCode: "none" },
    });
    expect(result.servedModel).toBe("deterministic-v1");
    expect(result.fallbackUsed).toBe(false);
    expect(result.usage).toMatchObject({ estimated: true });
  });

  it("默认 decision 响应对去重后超出的主体数按协议失败拒绝，不截断受众伪装成功", async () => {
    const port = await portWith();
    await expect(port.complete(
      modelRequest({ context: { workRef: "model-test", agentId: "human-independent", evaluatorId: null, round: 1, triggerPrincipalIds: principalIds } }),
      null, connection([]),
    )).rejects.toMatchObject({ kind: "protocol", retryable: false, httpStatus: null });
    // 五项记录含一个重复主体：去重后剩 4 个仍允许默认响应，受众只含去重后的主体。
    const deduplicated = await port.complete(
      modelRequest({ context: {
        workRef: "model-test", agentId: "human-independent", evaluatorId: null, round: 1,
        triggerPrincipalIds: [...principalIds.slice(0, 4), principalIds[0]!],
      } }),
      null, connection([]),
    );
    expect(deduplicated.toolCalls[0]?.arguments).toMatchObject({
      dialogueIntent: { audience: principalIds.slice(0, 4) },
    });
  });

  it("默认 decision 响应对零主体自主回合按协议失败，自主回合必须提供无对白夹具", async () => {
    const port = await portWith();
    await expect(port.complete(modelRequest(), null, connection([]))).rejects.toMatchObject({ kind: "protocol", retryable: false });
  });

  it("主体数超出默认范围时命中显式夹具并按主体数正向返回 decision_submit", async () => {
    const port = await portWith();
    const fivePrincipals = decisionFixture("five-principals", { purpose: "decision", triggerPrincipalCount: 5 });
    const request = modelRequest({
      context: { workRef: "model-test", agentId: "human-independent", evaluatorId: null, round: 1, triggerPrincipalIds: principalIds },
    });
    const result = await port.complete(request, null, connection([fivePrincipals]));
    expect(result.finishReason).toBe("tool_calls");
    expect(result.wire.responseBody).toMatchObject({ fixtureId: "five-principals" });
    expect(result.toolCalls[0]?.arguments).toMatchObject({
      dialogueIntent: { audience: principalIds, kind: "acknowledge" },
    });
  });

  it("speech、reflection 与 daily-review 的默认 JSON 响应满足各自契约", async () => {
    const port = await portWith();
    const jsonOutput = (schemaName: string): ModelRequest["output"] => ({ kind: "json", schemaName, schema: { type: "object" } });
    const speech = await port.complete(modelRequest({ purpose: "speech", output: jsonOutput("speech"), tools: [] }), null, connection([]));
    expect(speech.json).toEqual({ utterance: "我知道了。", citedRefs: [] });
    const reflection = await port.complete(modelRequest({ purpose: "memory-maintenance", output: jsonOutput("reflection"), tools: [] }), null, connection([]));
    expect(reflection.json).toEqual({ reflections: [] });
    const review = await port.complete(modelRequest({ purpose: "memory-maintenance", output: jsonOutput("daily-review"), tools: [] }), null, connection([]));
    expect(review.json).toEqual({ beliefOps: [], currentConcerns: null, intents: [] });
  });

  it("未知 JSON schema 与非 decision 文本请求按协议失败", async () => {
    const port = await portWith();
    await expect(port.complete(
      modelRequest({ purpose: "speech", output: statusOutput, tools: [] }),
      null, connection([]),
    )).rejects.toMatchObject({ kind: "protocol", retryable: false });
    await expect(port.complete(
      modelRequest({ purpose: "memory-maintenance", output: { kind: "text" }, tools: [] }),
      null, connection([]),
    )).rejects.toMatchObject({ kind: "protocol", retryable: false });
  });

  it("故障注入按错误种类返回传输错误并透传 retryAfterMs，可重试种类与分类表一致", async () => {
    const port = await portWith();
    const timeout = fixture("inject-timeout", { purpose: "decision" }, { error: { kind: "timeout", retryAfterMs: 250 } });
    await expect(port.complete(modelRequest(), null, connection([timeout]))).rejects.toMatchObject({
      kind: "timeout", retryable: true, retryAfterMs: 250, httpStatus: null,
    });
    const authFailure = fixture("inject-auth", { purpose: "decision" }, { error: { kind: "auth", retryAfterMs: null } });
    await expect(port.complete(modelRequest(), null, connection([authFailure]))).rejects.toMatchObject({
      kind: "auth", retryable: false, retryAfterMs: null,
    });
  });

  it("延迟注入先经注入的 sleep 等待再返回响应", async () => {
    const delays: number[] = [];
    const port = await portWith({ sleep: async (ms: number) => { delays.push(ms); } });
    const delayed = decisionFixture("delayed", { purpose: "decision", triggerPrincipalCount: 5 });
    const request = modelRequest({
      context: { workRef: "model-test", agentId: "human-independent", evaluatorId: null, round: 1, triggerPrincipalIds: principalIds },
    });
    const result = await port.complete(request, null, connection([{ ...delayed, response: { ...delayed.response, delayMs: 500 } }]));
    expect(delays).toEqual([500]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("夹具可声明 servedModel 与 fallbackUsed 以构造模型替换证据", async () => {
    const port = await portWith();
    const substituted = fixture("substituted", { purpose: "decision", triggerPrincipalCount: 5 }, {
      finishReason: "tool_calls",
      toolCalls: [{ name: "decision_submit", arguments: { stance: "none", decisionNote: "" } }],
      servedModel: "fallback-chat", fallbackUsed: true,
      usage: null,
    });
    const request = modelRequest({
      context: { workRef: "model-test", agentId: "human-independent", evaluatorId: null, round: 1, triggerPrincipalIds: principalIds },
    });
    const result = await port.complete(request, null, connection([substituted]));
    expect(result.servedModel).toBe("fallback-chat");
    expect(result.fallbackUsed).toBe(true);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, cachedInputTokens: null, estimated: false });
    expect(result.wire.requestBody).toMatchObject({ system: request.system, tools: request.tools });
    expect(result.wire.responseBody).toMatchObject({ fixtureId: "substituted", fallbackUsed: true });
  });
});
