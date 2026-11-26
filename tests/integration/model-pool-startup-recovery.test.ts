/**
 * 验证进程重启时预算与模型尝试证据的启动清扫。
 * 用真实 SQLite 写入崩溃遗留的未结算预留与 started 尝试，再重建模块两次。
 * 禁止依赖真实进程退出、修改开发存档或跳过持久化边界。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverModuleDefinitions } from "@world-prism/app-server";
import type { Json, StoragePort } from "@world-prism/contracts";
import type { AgentBudgetPort, AgentModelPoolPort, ModelObservabilityPort, ModelRoute, ModelWorkScope } from "@world-prism/module-sdk";
import { createFakeHost } from "./authority-support";

const roots: string[] = [];
const opened: { dispose(): Promise<void> }[] = [];

afterEach(async () => {
  for (const instance of opened.splice(0)) await instance.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), "world-prism-startup-recovery-"));
  roots.push(root);
  return root;
}

const route: ModelRoute = {
  agentId: "human-independent", purpose: "decision", modelId: "npc-fixture", connectionId: "fixtures",
  adapterId: "platform.model-transport.deterministic", externalModel: "deterministic-v1", endpoint: null,
  credentialRef: null, fixtureRows: [], rateLimitKey: "fixtures", parameters: {},
  capabilities: {
    toolCalling: true, strictTools: true, structuredOutput: "json_schema", assistantReplay: "verbatim",
    contextWindowTokens: 64_000, maxOutputTokens: 4096, embedding: false, embeddingDimensions: null,
  },
  configHash: "fixture-route", maxConcurrent: 1, maxOutputTokens: 100, requestTimeoutMs: 10_000,
  requestsPerMinute: 10, tokensPerMinute: 100_000,
  price: { inputPerMTok: 1, outputPerMTok: 2, currency: "USD" },
};

async function createModule(moduleId: string, ports: Readonly<Record<string, unknown>>, config: Json = {}) {
  const definition = serverModuleDefinitions.find(({ id }) => id === moduleId);
  if (definition === undefined) throw new Error(`Test provider missing: ${moduleId}`);
  const instance = await definition.create({
    moduleId: definition.id, realm: "server", config, scope: {}, ports,
    host: createFakeHost(), signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  opened.push(instance);
  return instance;
}

async function withStorage<T>(fn: (storage: StoragePort) => Promise<T>): Promise<T> {
  const root = dataRoot();
  const storageInstance = await createModule("platform.storage.sqlite", {}, { dataDir: root });
  try {
    return await fn(storageInstance.port as StoragePort);
  } finally {
    await storageInstance.dispose();
    opened.splice(opened.indexOf(storageInstance), 1);
  }
}

describe("启动清扫", () => {
  it("重启时把未结算预留按预留估值保守结算，重复启动不再改动", async () => {
    await withStorage(async (storage) => {
      const budget = await createModule("platform.budget.standard", { "platform.storage": storage });
      const reserve = (entryId: string) => (budget.port as AgentBudgetPort).reserve({
        entryId, scope: {
          worldId: "wld-000000000001", branchId: "br-000000000001", runId: "run-000000000001",
          agentId: route.agentId, workRef: "turn-000000000001", traceId: "trc-000000000001", worldTick: 26,
          triggerPrincipalIds: [], maxModelCalls: 6, maxDailyTokens: 60_000, deadlineMs: 90_000,
          signal: new AbortController().signal, fence: () => true,
        },
        limits: { maxTokens: null, maxCost: null }, route, reservedInput: 40, reservedOutput: 60,
      });
      reserve("att-crashed");
      const before = storage.transact((tx) => tx.rows("budget_ledger").get({ entry_id: "att-crashed" }));
      expect(before).toMatchObject({ settled_at: null, actual_input: null, actual_output: null, usage_unknown: 1 });

      // 模拟进程重启：同一 dataDir 再建一次预算模块。
      await createModule("platform.budget.standard", { "platform.storage": storage });
      const settled = storage.transact((tx) => tx.rows("budget_ledger").get({ entry_id: "att-crashed" }));
      expect(settled).toMatchObject({
        actual_input: 40, actual_output: 60, usage_unknown: 1, settled_at: expect.any(String),
      });
      const firstSettledAt = settled?.["settled_at"];

      await createModule("platform.budget.standard", { "platform.storage": storage });
      const unchanged = storage.transact((tx) => tx.rows("budget_ledger").get({ entry_id: "att-crashed" }));
      expect(unchanged?.["settled_at"]).toBe(firstSettledAt);
      expect(unchanged).toMatchObject({ actual_input: 40, actual_output: 60 });
    });
  });

  it("重启时把 started 尝试标记为 process-interrupted 并把运行证据标为不完整，重复启动保持幂等", async () => {
    await withStorage(async (storage) => {
      const initial = await createModule("agent.model-pool.shared", {
        "platform.storage": storage,
        "platform.budget": { check: vi.fn(), reserve: vi.fn(), settle: vi.fn() } satisfies AgentBudgetPort,
        "platform.secrets": { resolve: () => null },
        "platform.observability": { recordSpan: vi.fn() } satisfies ModelObservabilityPort,
        "platform.model-transport": [],
      });
      await initial.dispose();
      opened.splice(opened.indexOf(initial), 1);
      storage.transact((tx) => {
        tx.rows("worlds").put({
          world_id: "wld-000000000001", pack_id: "earth-2964-v1", content_version: "1.0.0",
          created_at: "2026-01-01T00:00:00.000Z",
        });
        tx.rows("branches").put({
          branch_id: "br-000000000001", world_id: "wld-000000000001", kind: "online", status: "active",
          parent_branch_id: null, forked_at_world_seq: null, run_id: null, profile_hash: null,
          created_at: "2026-01-01T00:00:00.000Z",
        });
        tx.rows("runs").put({
          run_id: "run-000000000001", world_id: "wld-000000000001", branch_id: "br-000000000001",
          mode: "live", status: "running", run_spec_json: {}, manifest_json: null, manifest_hash: null,
          contaminated: 0, evidence_complete: 1, created_at: "2026-01-01T00:00:00.000Z",
          started_at: null, ended_at: null,
        });
        tx.rows("model_attempts").put({
          attempt_id: "att-crashed", llm_call_id: "llm-000000000001", run_id: "run-000000000001",
          work_ref: "turn-000000000001", agent_id: route.agentId, evaluator_id: null, purpose: "decision",
          model_id: route.modelId, connection_id: route.connectionId, adapter_id: route.adapterId,
          status: "started", is_effective: 0, request_artifact_id: null, response_artifact_id: null,
          usage_json: null, timings_json: null, error_json: null, created_at: "2026-01-01T00:00:00.000Z",
        });
      });

      const restarted = await createModule("agent.model-pool.shared", {
        "platform.storage": storage,
        "platform.budget": { check: vi.fn(), reserve: vi.fn(), settle: vi.fn() } satisfies AgentBudgetPort,
        "platform.secrets": { resolve: () => null },
        "platform.observability": { recordSpan: vi.fn() } satisfies ModelObservabilityPort,
        "platform.model-transport": [],
      });
      const recovered = storage.transact((tx) => ({
        attempt: tx.rows("model_attempts").get({ attempt_id: "att-crashed" }),
        run: tx.rows("runs").get({ run_id: "run-000000000001" }),
      }));
      expect(recovered.attempt).toMatchObject({ status: "failed", is_effective: 0, error_json: { kind: "process-interrupted" } });
      expect(recovered.run).toMatchObject({ evidence_complete: 0 });

      await restarted.dispose();
      opened.splice(opened.indexOf(restarted), 1);
      await createModule("agent.model-pool.shared", {
        "platform.storage": storage,
        "platform.budget": { check: vi.fn(), reserve: vi.fn(), settle: vi.fn() } satisfies AgentBudgetPort,
        "platform.secrets": { resolve: () => null },
        "platform.observability": { recordSpan: vi.fn() } satisfies ModelObservabilityPort,
        "platform.model-transport": [],
      });
      const repeated = storage.transact((tx) => ({
        attempt: tx.rows("model_attempts").get({ attempt_id: "att-crashed" }),
        run: tx.rows("runs").get({ run_id: "run-000000000001" }),
      }));
      expect(repeated.attempt).toMatchObject({ status: "failed", error_json: { kind: "process-interrupted" } });
      expect(repeated.run).toMatchObject({ evidence_complete: 0 });
    });
  });
});

describe("证据归档与启动清理的查询路径", () => {
  it("模型尝试 span 的模块标识与版本取自模块定义，避免两处漂移", async () => {
    await withStorage(async (storage) => {
      const spans: { moduleId: string | null; moduleVersion: string | null; name: string }[] = [];
      const budget = await createModule("platform.budget.standard", { "platform.storage": storage });
      const definition = serverModuleDefinitions.find(({ id }) => id === "agent.model-pool.shared");
      if (definition === undefined) throw new Error("缺少 agent.model-pool.shared 描述符");
      const transport = await createModule("platform.model-transport.deterministic", {});
      const pool = await createModule("agent.model-pool.shared", {
        "platform.storage": storage,
        "platform.budget": budget.port,
        "platform.secrets": { resolve: () => null },
        "platform.observability": {
          recordSpan: (span) => { spans.push({ moduleId: span.moduleId, moduleVersion: span.moduleVersion, name: span.name }); },
        } satisfies ModelObservabilityPort,
        "platform.model-transport": [transport.port],
      });
      const run = (pool.port as AgentModelPoolPort).bindRun({
        routes: [{ ...route, adapterId: definition.id.replace("agent.model-pool.shared", "platform.model-transport.deterministic"),
          fixtureRows: [] }],
        limits: { maxTokens: null, maxCost: null },
      });
      // 零主体 decision 请求命不中默认响应，必然失败；这里只关心 span 元数据是否写全。
      const callScope: ModelWorkScope = {
        worldId: "wld-000000000001", branchId: "br-000000000001", runId: "run-000000000001",
        agentId: route.agentId, workRef: "turn-000000000002", traceId: "trc-000000000002", worldTick: 26,
        triggerPrincipalIds: [], maxModelCalls: 6, maxDailyTokens: 60_000, deadlineMs: 90_000,
        signal: new AbortController().signal, fence: () => true,
      };
      await expect(run.call(callScope, "decision", 100, {
        system: "测试", messages: [{ role: "user", content: "hi" }], tools: [], output: { kind: "text" },
        inputLimit: 10_000, round: 1,
      })).rejects.toBeDefined();
      expect(spans).toEqual([
        expect.objectContaining({ name: "model.attempt", moduleId: definition.id, moduleVersion: definition.version }),
      ]);
      expect(definition.version).toBe("1.0.0");
    });
  });

  it("启动清理与尝试恢复都命中索引，不触发账本与尝试表的全表扫描", async () => {
    await withStorage(async (storage) => {
      const cleanup = storage.transact((tx) => tx.all(
        "EXPLAIN QUERY PLAN UPDATE budget_ledger SET actual_input = reserved_input WHERE settled_at IS NULL", []));
      const recovery = storage.transact((tx) => tx.all(
        "EXPLAIN QUERY PLAN SELECT * FROM model_attempts WHERE status = 'started'", []));
      const details = (rows: readonly Readonly<Record<string, unknown>>[]) => rows.map((row) => String(row["detail"]));
      expect(details(cleanup)).toEqual([
        expect.stringContaining("USING INDEX budget_ledger_unsettled"),
      ]);
      expect(details(recovery)).toEqual([
        expect.stringContaining("USING INDEX model_attempts_status"),
      ]);
      expect(details(cleanup).concat(details(recovery)).some((detail) => detail.startsWith("SCAN "))).toBe(false);
    });
  });
});
