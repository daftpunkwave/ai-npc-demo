/**
 * 对已配置供应商执行一次工具往返和一次独立 JSON 输出。
 * 使用合成的门状态与固定工具定义检查端口返回、回放和结构化响应。
 * 禁止发送真实玩家数据、世界上下文或记录凭据。
 */
import { expect } from "vitest";
import type { ModelConnectionInput, ModelRequest, ModelTransportPort } from "@ai-npc/contracts";
import { modelRequest, statusOutput } from "../support/model-transport";

export async function verifyModelTransport(
  port: ModelTransportPort,
  credential: string,
  connection: ModelConnectionInput,
  model: Pick<ModelRequest, "externalModel" | "parameters">,
): Promise<void> {
  const common = { ...model, maxOutputTokens: 4096, timeoutMs: 50_000 };
  const decision = modelRequest(common);
  const first = await port.complete(decision, credential, connection);
  expect(first.finishReason).toBe("tool_calls");
  expect(first.toolCalls).toHaveLength(1);
  const call = first.toolCalls[0];
  if (call === undefined) throw new Error("A read_status tool call is required");
  expect(call).toMatchObject({ name: "read_status", arguments: { gate: "west" }, parseError: null });
  const second = await port.complete({ ...decision, messages: [
    ...decision.messages,
    { role: "assistant", content: first.text, toolCalls: first.toolCalls, providerReplay: first.providerReplay },
    { role: "tool", toolCallId: call.id, isError: false, content: '{"ready":true}' },
  ] }, credential, connection);
  expect(second.finishReason).toBe("stop");
  expect(second.text).toEqual(expect.any(String));

  const speech = await port.complete(modelRequest({
    ...common, purpose: "speech", tools: [], output: statusOutput, system: "Return JSON only, for example {\"ready\":true}.",
    messages: [{ role: "user", content: "The gate is ready. Report its readiness in the JSON field ready." }],
  }), credential, connection);
  expect(speech).toMatchObject({ finishReason: "stop", json: { ready: true }, jsonError: null });
}
