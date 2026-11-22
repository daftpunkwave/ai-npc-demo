/**
 * 验证模型池共享限额、重试退避、持久预算与凭据脱敏证据的尝试级原子语义。
 * 使用真实 SQLite、预算和模型池 provider，时间与单次传输由测试注入。
 * 禁止联网、等待真实退避或跟其他运行共享数据库。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serverModuleDefinitions } from "@ai-npc/app-server";
import { estimateModelInputTokens, type ModelResponse, type ModelTransportError, type ModelTransportPort, type StoragePort } from "@ai-npc/contracts";
import type { AgentModelPoolPort, ModelCallInput, ModelRoute, ModelWorkScope } from "@ai-npc/module-sdk";
import { createFakeHost } from "./authority-support";
import { storageFailingOnLifecycleAudit } from "./lifecycle-audit-support";

const capabilities = {
  toolCalling: true, strictTools: true, structuredOutput: "json_schema", assistantReplay: "verbatim",
  contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null,
} as const;
const route: ModelRoute = {
  agentId: "human-independent", purpose: "decision", modelId: "npc-fixture", connectionId: "fixtures",
  adapterId: "fixture-adapter", externalModel: "deterministic-v1", endpoint: null, credentialRef: null,
  fixtureRows: [], rateLimitKey: "same-account", parameters: {}, capabilities,
  configHash: "fixture-route",
  maxConcurrent: 1, maxOutputTokens: 100, requestTimeoutMs: 10_000, requestsPerMinute: 10, tokensPerMinute: 100_000,
  price: { inputPerMTok: 1, outputPerMTok: 2, currency: "USD" },
};
const request: ModelCallInput = {
  system: "规则", messages: [{ role: "user", content: "测试请求" }], tools: [], output: { kind: "text" },
  inputLimit: 1000, round: 1,
};
const response: ModelResponse = {
  finishReason: "stop", text: "收到", json: null, jsonError: null, toolCalls: [], providerReplay: null,
  usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, estimated: false },
  servedModel: "deterministic-v1", providerRequestId: null, fallbackUsed: false,
  wire: { requestBody: {}, responseBody: {} },
};

function work(overrides: Partial<ModelWorkScope> = {}): ModelWorkScope {
  return {
    worldId: "wld-000000000001", branchId: "br-000000000001", runId: "run-000000000001",
    agentId: route.agentId, workRef: "turn-000000000001", traceId: "trc-000000000001", worldTick: 25,
    triggerPrincipalIds: ["player-1"], maxModelCalls: 6, maxDailyTokens: 60_000, deadlineMs: 90_000,
    signal: new AbortController().signal, fence: () => true, ...overrides,
  };
}

async function poolHarness(
  complete: ModelTransportPort["complete"],
  credential: string | null = null,
  wrapStorage: (storage: StoragePort) => StoragePort = (storage) => storage,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "ai-npc-model-pool-"));
  const timers = new Set<{ at: number; resolve: () => void }>();
  const retryWaits: number[] = [];
  let now = 0;
  const host = {
    ...createFakeHost(), monotonicMs: () => now,
    sleep: (ms: number, signal?: AbortSignal) => {
      if (ms === 1000 || ms === 4000) {
        retryWaits.push(ms);
        now += ms;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const entry = { at: now + ms, resolve: () => { signal?.removeEventListener("abort", abort); resolve(); } };
        const abort = () => { timers.delete(entry); reject(new Error("Test sleep cancelled")); };
        if (signal?.aborted) abort();
        else {
          timers.add(entry);
          signal?.addEventListener("abort", abort, { once: true });
        }
      });
    },
  };
  const signal = new AbortController().signal;
  const create = (moduleId: string, ports: Readonly<Record<string, unknown>>, config = {}) => {
    const module = serverModuleDefinitions.find(({ id }) => id === moduleId);
    if (module === undefined) throw new Error(`Test provider missing: ${moduleId}`);
    return module.create({ host, signal, moduleId, ports, config, realm: "server", scope: {} });
  };
  const storageInstance = await create("platform.storage.sqlite", {}, { dataDir });
  await storageInstance.start(signal);
  const storage = storageInstance.port as StoragePort;
  const budget = await create("platform.budget.standard", { "platform.storage": storage });
  const pool = await create("agent.model-pool.shared", {
    "platform.storage": wrapStorage(storage),
    "platform.budget": budget.port,
    "platform.secrets": { resolve: () => credential },
    "platform.observability": { recordSpan: vi.fn() },
    "platform.model-transport": [{ adapterId: route.adapterId, capabilities: () => capabilities, complete }],
  });
  await budget.start(signal);
  await pool.start(signal);
  return {
    storage, pool: pool.port as AgentModelPoolPort, retryWaits,
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.resolve();
        }
      }
    },
    async dispose() {
      await pool.dispose();
      await budget.dispose();
      await storageInstance.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function networkError(kind: "network" | "server"): ModelTransportError {
  return { kind, retryable: true, retryAfterMs: null, httpStatus: null, message: kind };
}

const limits = { maxTokens: null, maxCost: null };

describe("共享模型池与预算", () => {
  it("发送上限与预留一致，即使挂载允许更大的输出", async () => {
    const complete = vi.fn<ModelTransportPort["complete"]>().mockResolvedValue(response);
    const harness = await poolHarness(complete);
    try {
      const run = harness.pool.bindRun({ routes: [route], limits });
      await run.call(work(), "decision", 30, request);
      expect(complete.mock.calls[0]?.[0].maxOutputTokens).toBe(30);
      const entries = harness.storage.transact((tx) => tx.rows("budget_ledger").list({ work_ref: work().workRef }));
      expect(entries).toEqual([expect.objectContaining({ reserved_output: 30, actual_output: 30 })]);
    } finally {
      await harness.dispose();
    }
  });

  it("阻断含凭据的响应并保存脱敏证据", async () => {
    const credential = "fixture-only-test-secret";
    const complete = vi.fn<ModelTransportPort["complete"]>().mockResolvedValue({
      ...response, text: credential, wire: { requestBody: { value: credential }, responseBody: { value: credential } },
    });
    const harness = await poolHarness(complete, credential);
    try {
      const run = harness.pool.bindRun({ routes: [{ ...route, credentialRef: "SYNTHETIC_MODEL_KEY" }], limits });
      await expect(run.call(work(), "decision", 100, request)).rejects.toMatchObject({ code: "provider-failed" });
      expect(complete.mock.calls[0]?.[1]).toBe(credential);
      const evidence = harness.storage.transact((tx) => ({
        attempt: tx.rows("model_attempts").list({ work_ref: work().workRef })[0],
        artifacts: tx.rows("artifacts").list(),
        events: tx.rows("lifecycle_events").list({ type: "ModelCredentialRedacted" }),
      }));
      expect(evidence.attempt).toMatchObject({ is_effective: 0, status: "failed" });
      expect(evidence.events).toHaveLength(1);
      expect(evidence.artifacts).toHaveLength(2);
      for (const artifact of evidence.artifacts) {
        const body = artifact["body"];
        expect(body).toBeInstanceOf(Uint8Array);
        const text = new TextDecoder().decode(body as Uint8Array);
        expect(text).toContain("[REDACTED]");
        expect(text).not.toContain(credential);
      }
    } finally {
      await harness.dispose();
    }
  });

  it("脱敏审计与 attempt 终态同事务：审计写入失败时终态一并回滚", async () => {
    const credential = "fixture-only-test-secret";
    const complete = vi.fn<ModelTransportPort["complete"]>().mockResolvedValue({
      ...response, text: credential, wire: { requestBody: { value: credential }, responseBody: { value: credential } },
    });
    const harness = await poolHarness(
      complete,
      credential,
      (storage) => storageFailingOnLifecycleAudit(storage, "注入审计写入失败"),
    );
    try {
      const run = harness.pool.bindRun({ routes: [{ ...route, credentialRef: "SYNTHETIC_MODEL_KEY" }], limits });
      await expect(run.call(work(), "decision", 100, request)).rejects.toMatchObject({ code: "provider-failed" });
      const state = harness.storage.transact((tx) => ({
        attempt: tx.rows("model_attempts").list({ work_ref: work().workRef })[0],
        events: tx.rows("lifecycle_events").list({ type: "ModelCredentialRedacted" }),
      }));
      // 同一事务回滚：attempt 不落终态，也不留下脱敏事件半套记录。
      expect(state.attempt).toMatchObject({ status: "started", is_effective: 0 });
      expect(state.events).toHaveLength(0);
    } finally {
      await harness.dispose();
    }
  });

  it("重试等待 1 秒、4 秒并为每次尝试按预留结算未知用量", async () => {
    const complete = vi.fn<ModelTransportPort["complete"]>()
      .mockRejectedValueOnce(networkError("network"))
      .mockRejectedValueOnce(networkError("server"))
      .mockResolvedValue(response);
    const harness = await poolHarness(complete);
    try {
      const run = harness.pool.bindRun({ routes: [route], limits });
      const result = await run.call(work(), "decision", 100, request);
      expect(harness.retryWaits).toEqual([1000, 4000]);
      expect(new Set(complete.mock.calls.map(([input]) => input.llmCallId)).size).toBe(1);
      expect(new Set(result.attempts.map(({ attemptId }) => attemptId)).size).toBe(3);
      expect(result.attempts.map(({ status }) => status)).toEqual(["superseded", "superseded", "succeeded"]);
      const entries = harness.storage.transact((tx) => tx.rows("budget_ledger").list({ work_ref: work().workRef }));
      expect(entries).toHaveLength(3);
      const estimated = estimateModelInputTokens(request);
      for (const entry of entries) expect(entry).toMatchObject({
        world_day: 2, actual_input: estimated, actual_output: 100, usage_unknown: 1,
        cost_estimate: (estimated + 200) / 1_000_000, settled_at: expect.any(String),
      });
    } finally {
      await harness.dispose();
    }
  });

  it("多个模型 ID 共享账号限额，等待滑动窗口释放后才发送", async () => {
    const complete = vi.fn<ModelTransportPort["complete"]>().mockResolvedValue(response);
    const harness = await poolHarness(complete);
    try {
      const first = { ...route, requestsPerMinute: 1 };
      const second = { ...first, modelId: "same-account-alias", agentId: "human-earth-alliance" };
      const run = harness.pool.bindRun({ routes: [first, second], limits });
      await run.call(work(), "decision", 100, request);
      const waiting = run.call(work({ agentId: second.agentId, workRef: "turn-000000000002" }), "decision", 100, request);
      harness.advance(59_999);
      await Promise.resolve();
      expect(complete).toHaveBeenCalledTimes(1);
      harness.advance(1);
      await waiting;
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      await harness.dispose();
    }
  });

  it("三个主体同时积压时各自轮流获得模型名额", async () => {
    let releaseFirst: (() => void) | undefined;
    const held = new Promise<ModelResponse>((resolve) => { releaseFirst = () => resolve(response); });
    const complete = vi.fn<ModelTransportPort["complete"]>().mockReturnValueOnce(held).mockResolvedValue(response);
    const harness = await poolHarness(complete);
    try {
      const first = "species-fauna";
      const [a, b, c] = ["human-independent", "human-earth-alliance", "human-alien-accord"] as const;
      const calls = [first, a, a, b, b, c];
      const run = harness.pool.bindRun({ routes: [...new Set(calls)].map((agentId) => ({ ...route, agentId })), limits });
      const pending = calls.map((agentId, index) => run.call(work({
        agentId, workRef: `turn-${String(index + 1).padStart(12, "0")}`,
      }), "decision", 100, request));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
      releaseFirst?.();
      await Promise.all(pending);
      expect(complete.mock.calls.map(([input]) => input.context.agentId)).toEqual([first, a, b, c, a, b]);
    } finally {
      releaseFirst?.();
      await harness.dispose();
    }
  });

  it("单轮预算包含重试，耗尽时不再发送", async () => {
    const complete = vi.fn<ModelTransportPort["complete"]>().mockRejectedValue(networkError("network"));
    const harness = await poolHarness(complete);
    try {
      const run = harness.pool.bindRun({ routes: [route], limits });
      await expect(run.call(work({ maxModelCalls: 1 }), "decision", 100, request))
        .rejects.toMatchObject({ code: "budget-exhausted" });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(harness.retryWaits).toEqual([]);
      expect(harness.storage.transact((tx) => tx.rows("model_attempts").list({}))).toEqual([
        expect.objectContaining({ status: "failed", is_effective: 0 }),
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("预算耗尽时立即拒绝，即使共享账号没有空闲额度", async () => {
    const complete = vi.fn<ModelTransportPort["complete"]>().mockResolvedValue(response);
    const harness = await poolHarness(complete);
    try {
      const run = harness.pool.bindRun({ routes: [{ ...route, requestsPerMinute: 1 }], limits });
      const scope = work({ maxModelCalls: 1 });
      await run.call(scope, "decision", 100, request);
      await expect(run.call(scope, "decision", 100, request)).rejects.toMatchObject({ code: "budget-exhausted" });
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      await harness.dispose();
    }
  });
});
