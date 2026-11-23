/**
 * 核心职责：为记忆策略回归提供模型响应与多 Agent 宿主夹具。
 * 交互契约：复用真实 SQLite 夹具，只通过 MemoryHost 发布记忆。
 * 约束与禁忌：禁止直接修改记忆行、revision 或水位来制造预期结果。
 */
import type { AgentModelCallResult, Json } from "@ai-npc/contracts";
import type { RunModelPort } from "@ai-npc/module-sdk";
import { MemoryHost, type MemoryHostOptions } from "@ai-npc/agent-runtime";
import { memoryAgentId, memoryBranchId, memoryIdentity, memoryRunId, memoryWorldId, type MemoryHarness } from "./memory-support";

export const memoryModelRoute: ReturnType<RunModelPort["route"]> = {
  capabilities: { toolCalling: false, strictTools: false, structuredOutput: "json_schema", assistantReplay: "standard", contextWindowTokens: 8192, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null },
  maxOutputTokens: 4096,
};

/** 单次模型替身履行实际发送前的宿主配额回调。 */
export function oneAttemptModel(call: RunModelPort["call"]): RunModelPort {
  return {
    route: () => memoryModelRoute,
    call: (work, ...args) => {
      work.beforeAttempt?.();
      return call(work, ...args);
    },
  };
}

export function modelResponse(json: Json): AgentModelCallResult {
  return {
    response: {
      finishReason: "stop", text: null, json, jsonError: null, toolCalls: [], providerReplay: null,
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, estimated: false },
      servedModel: "fixture", providerRequestId: null, fallbackUsed: false, wire: { requestBody: {}, responseBody: {} },
    },
    attempts: [],
  };
}

export async function startVariantHost(harness: MemoryHarness, options: Partial<MemoryHostOptions> = {}): Promise<MemoryHost> {
  const host = new MemoryHost({
    storage: harness.storage, host: harness.host, roster: harness.roster,
    profiles: new Map([[memoryAgentId, harness.profile]]), moduleDefinitions: harness.definitions,
    identities: new Map([[memoryAgentId, memoryIdentity]]), worldId: memoryWorldId,
    branchId: memoryBranchId, runId: memoryRunId, signal: new AbortController().signal,
    maintenanceConcurrency: 1, ...options,
  });
  await host.start();
  return host;
}
