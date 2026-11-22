/**
 * 为真实标准装配提供隔离的部署变量与 OpenAI 兼容 HTTP 响应。
 * 保留宿主、模型池、适配器和 SQLite 的正常调用，允许测试访问应用回环地址。
 * 禁止把模型请求发给外部供应商或读取用户本地凭据。
 */
import { vi } from "vitest";

const origin = "https://model.example.test";
const externalModel = "integration-test-model";
export const standardModelTestKey = "integration-test-api-key";

export function stubStandardModelHttp(): () => void {
  vi.stubEnv("NPC_OPENAI_COMPAT_BASE_URL", `${origin}/v1`);
  vi.stubEnv("NPC_OPENAI_COMPAT_MODEL", externalModel);
  vi.stubEnv("NPC_OPENAI_COMPAT_API_KEY", standardModelTestKey);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  const originalFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.hostname === "127.0.0.1") return originalFetch(url, init);
    if (target.href !== `${origin}/v1/chat/completions`) throw new Error("Unexpected outbound address in integration test");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${standardModelTestKey}`) {
      return Response.json({ error: "invalid fixture credential" }, { status: 401 });
    }
    const body = JSON.parse(String(init?.body)) as { tools?: unknown[] };
    const hasTools = body.tools !== undefined;
    const argumentsRaw = JSON.stringify({
      stance: "none", dialogueIntent: { kind: "acknowledge", audience: ["player-1"], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
      noteworthy: [], citedMemoryIds: [], decisionNote: "",
    });
    const message = hasTools
      ? { role: "assistant", content: null, tool_calls: [{ id: "call-decision", type: "function", function: { name: "decision_submit", arguments: argumentsRaw } }] }
      : { role: "assistant", content: '{"utterance":"收到，我会留意。","citedRefs":[]}' };
    return Response.json({ id: "test-model-reply", model: externalModel, choices: [{ finish_reason: hasTools ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 30, completion_tokens: 20 } });
  });
  return () => {
    spy.mockRestore();
    vi.unstubAllEnvs();
  };
}
