/**
 * 为传输契约和手动连通性测试构建规范请求、连接与适配器端口。
 * 测试经模块的公开描述符创建实例，依赖注入的传输替身或人工提供的凭据。
 * 禁止在测试准备阶段发请求、访问存档或读取模型密钥。
 */
import type { HostServices, ModelCapabilities, ModelConnectionInput, ModelRequest, ModelTransportPort, ModuleDefinition } from "@ai-npc/contracts";

export const statusOutput = {
  kind: "json", schemaName: "status", schema: {
    type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false,
  },
} satisfies ModelRequest["output"];

export function modelRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    llmCallId: "llm-000000000001", attemptId: "att-000000000001", purpose: "decision", externalModel: "test-chat",
    system: "Use the read_status tool to answer the user. After receiving a result, answer without calling another tool.",
    messages: [{ role: "user", content: "Call read_status for the west gate, then report whether it is ready." }],
    tools: [{ name: "read_status", description: "Read the status of a gate", inputSchema: {
      type: "object", properties: { gate: { type: "string" } }, required: ["gate"], additionalProperties: false,
    } }],
    output: { kind: "text" }, parameters: {}, maxOutputTokens: 1024, timeoutMs: 3000,
    context: { workRef: "model-test", agentId: null, evaluatorId: null, round: 1, triggerPrincipalIds: [] },
    ...overrides,
  };
}

export function modelConnection(overrides: Partial<ModelConnectionInput> = {}, caps: Partial<ModelCapabilities> = {}): ModelConnectionInput {
  return {
    endpoint: "https://model.example.test/v1/", fixtures: [], signal: new AbortController().signal,
    capabilities: {
      toolCalling: true, strictTools: false, structuredOutput: "json_object", assistantReplay: "standard",
      contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null, ...caps,
    },
    jsonOutputSuffix: "Return one JSON object that matches this schema:",
    ...overrides,
  };
}

export async function transportPort(definition: ModuleDefinition): Promise<ModelTransportPort> {
  const host = new Proxy({} as HostServices, { get: () => { throw new Error("Transport requested an unexpected host service"); } });
  const instance = await definition.create({
    moduleId: definition.id, realm: "server", config: {}, scope: {}, ports: {}, host,
    signal: new AbortController().signal,
  });
  return instance.port as ModelTransportPort;
}
