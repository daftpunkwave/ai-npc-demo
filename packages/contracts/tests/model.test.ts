/**
 * 验证规范化模型请求、响应、错误与能力声明的 schema。
 * 依赖公共契约包的 model 主题导出。
 * 禁止真实调用模型或读取密钥；样例只覆盖数据形状。
 */
import { describe, expect, it } from "vitest";
import {
  modelCapabilitiesSchema,
  modelEmbeddingResponseSchema,
  modelOutputSchema,
  modelPurposeSchema,
  modelRequestContextSchema,
  modelRequestSchema,
  modelResponseSchema,
  modelTransportErrorKindSchema,
  modelTransportErrorSchema,
  modelUsageSchema,
  modelWireSchema,
  normalizedMessageSchema,
  normalizedToolCallSchema,
  normalizedToolSchema,
} from "../src/index";
import { expectInvalid, expectSchema } from "./support";

const toolCall = {
  id: "call_1",
  name: "world_inspect",
  arguments: { nodeId: "pass" },
  argumentsRaw: '{"nodeId":"pass"}',
  parseError: null,
};

describe("用途与工具定义", () => {
  it("模型用途固定六类", () => {
    for (const value of [
      "decision",
      "speech",
      "memory-maintenance",
      "compression",
      "embedding",
      "evaluation",
    ]) {
      expect(modelPurposeSchema.safeParse(value).success).toBe(true);
    }
    expectInvalid(modelPurposeSchema, "chat");
  });

  it("规范化工具定义与工具调用", () => {
    expectSchema(
      normalizedToolSchema,
      {
        name: "world_inspect",
        description: "查看你所知道的局势。",
        inputSchema: { type: "object", properties: { nodeId: { type: ["string", "null"] } } },
      },
      { name: "", description: "", inputSchema: {} },
    );
    expectSchema(normalizedToolCallSchema, toolCall, { ...toolCall, argumentsRaw: undefined });
    expectSchema(
      normalizedToolCallSchema,
      { ...toolCall, arguments: null, parseError: "JSON 解析失败" },
      { ...toolCall, parseError: 1 },
    );
  });
});

describe("规范化消息", () => {
  it("接受 user、assistant 与 tool 三种消息", () => {
    expectSchema(normalizedMessageSchema, { role: "user", content: "你好" }, { role: "user" });
    expectSchema(
      normalizedMessageSchema,
      { role: "assistant", content: null, toolCalls: [toolCall], providerReplay: null },
      { role: "assistant", content: null, toolCalls: [{ ...toolCall, parseError: 1 }], providerReplay: null },
    );
    expectSchema(
      normalizedMessageSchema,
      { role: "tool", toolCallId: "call_1", content: '{"ok":true}', isError: false },
      { role: "tool", toolCallId: "", content: "", isError: false },
    );
    expectInvalid(normalizedMessageSchema, { role: "system", content: "x" });
  });
});

describe("输出约定", () => {
  it("文本或受 schema 约束的 JSON", () => {
    expectSchema(modelOutputSchema, { kind: "text" }, { kind: "text", schema: {} });
    expectSchema(
      modelOutputSchema,
      { kind: "json", schemaName: "speech", schema: { type: "object" } },
      { kind: "json", schemaName: "", schema: {} },
    );
    expectInvalid(modelOutputSchema, { kind: "xml" });
  });
});

describe("ModelRequest", () => {
  const request = {
    llmCallId: "llm-k3j9x0a1b2c3",
    attemptId: "att-k3j9x0a1b2c3",
    purpose: "decision",
    externalModel: "npc-chat",
    system: "你是岑雁。",
    messages: [{ role: "user", content: "请做决定。" }],
    tools: [],
    output: { kind: "text" },
    maxOutputTokens: 1500,
    parameters: { temperature: 0.6 },
    timeoutMs: 30000,
    context: {
      agentId: "npc-cenyan",
      evaluatorId: null,
      workRef: "turn-k3j9x0a1b2c3",
      round: 1,
      triggerPrincipalIds: ["player-1"],
    },
  };

  it("接受合法请求并拒绝错误 ID 与超时", () => {
    expectSchema(modelRequestSchema, request, { ...request, attemptId: "attempt-1" });
    expectInvalid(modelRequestSchema, { ...request, maxOutputTokens: 0 });
    expectInvalid(modelRequestSchema, { ...request, timeoutMs: -1 });
    expectInvalid(modelRequestSchema, { ...request, context: { ...request.context, round: 0 } });
  });
});

describe("ModelResponse", () => {
  const response = {
    finishReason: "tool_calls",
    text: null,
    json: null,
    jsonError: null,
    toolCalls: [toolCall],
    providerReplay: null,
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: null,
      estimated: false,
    },
    servedModel: "npc-chat",
    providerRequestId: "req_1",
    fallbackUsed: false,
    wire: { requestBody: { model: "npc-chat" }, responseBody: { id: "req_1" } },
  };

  it("接受合法响应并拒绝未知结束原因", () => {
    expectSchema(modelResponseSchema, response, { ...response, finishReason: "stop-now" });
    expectInvalid(modelResponseSchema, {
      ...response,
      usage: { ...response.usage, inputTokens: -1 },
    });
    expectInvalid(modelResponseSchema, { ...response, wire: { requestBody: Number.NaN, responseBody: {} } });
  });
});

describe("传输错误与能力", () => {
  it("错误分类与可重试标记", () => {
    const error = {
      kind: "rate-limited",
      retryable: true,
      retryAfterMs: 2000,
      httpStatus: 429,
      message: "请求过于频繁",
    };
    expectSchema(modelTransportErrorSchema, error, { ...error, kind: "quota" });
    expectInvalid(modelTransportErrorSchema, { ...error, httpStatus: 1.5 });
  });

  it("传输错误分类枚举覆盖全部取值", () => {
    for (const kind of [
      "rate-limited",
      "timeout",
      "network",
      "server",
      "bad-request",
      "auth",
      "not-found",
      "protocol",
    ]) {
      expect(modelTransportErrorKindSchema.safeParse(kind).success).toBe(true);
    }
    expectInvalid(modelTransportErrorKindSchema, "offline");
  });

  it("请求上下文、用量与线协议原文", () => {
    expectSchema(
      modelRequestContextSchema,
      {
        agentId: "npc-cenyan",
        evaluatorId: null,
        workRef: "turn-k3j9x0a1b2c3",
        round: 1,
        triggerPrincipalIds: ["player-1"],
      },
      {
        agentId: "npc-cenyan",
        evaluatorId: null,
        workRef: "",
        round: 1,
        triggerPrincipalIds: [],
      },
    );
    expectSchema(
      modelUsageSchema,
      { inputTokens: 1, outputTokens: null, cachedInputTokens: null, estimated: true },
      { inputTokens: -1, outputTokens: null, cachedInputTokens: null, estimated: true },
    );
    expectSchema(modelWireSchema, { requestBody: { model: "npc-chat" }, responseBody: null }, { requestBody: Number.NaN });
  });

  it("能力声明", () => {
    const capabilities = {
      toolCalling: true,
      strictTools: false,
      structuredOutput: "json_object",
      assistantReplay: "standard",
      contextWindowTokens: 64000,
      maxOutputTokens: 4096,
      embedding: false,
      embeddingDimensions: null,
    };
    expectSchema(modelCapabilitiesSchema, capabilities, { ...capabilities, structuredOutput: "xml" });
    expectInvalid(modelCapabilitiesSchema, { ...capabilities, contextWindowTokens: 0 });
  });

  it("向量响应", () => {
    expectSchema(
      modelEmbeddingResponseSchema,
      { vectors: [[0.1, 0.2]], usage: { inputTokens: 3 } },
      { vectors: [["x"]], usage: { inputTokens: 3 } },
    );
  });
});
