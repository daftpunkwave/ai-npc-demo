/**
 * 核心职责：验证观测查询与调试审计在独立分支、异常存储行和队列变化下的结果。
 * 交互契约：直接调用观测端口，使用独立 SQLite 与确定性 HostServices。
 * 约束与禁忌：不启动 HTTP、模型或后台调度器，不复用游戏数据库。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, type Json, type ModuleInstance, type StoragePort, type StorageTransaction } from "@world-prism/contracts";
import { ObservabilityPort } from "@world-prism/mod-platform-observability-sqlite";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { createFakeHost } from "./authority-support";

const worldId = "wld-observability";
const left = { branchId: "br-000000000001", runId: "run-000000000001" };
const right = { branchId: "br-000000000002", runId: "run-000000000002" };
const agentId = "human-independent";
const createdAt = "2026-01-01T00:00:00.000Z";
const operationId = "op-000000000001";
const researcher = "researcher-fixture";

function putEvent(tx: StorageTransaction, branchId: string, seq: number, payload: Json): void {
  tx.branch(branchId).table("domain_events").put({
    world_seq: seq,
    event_id: `evt-${String(seq).padStart(12, "0")}`,
    world_tick: 1,
    type: "WorldEvent",
    schema_version: 1,
    principal_id: agentId,
    causation_ids_json: [],
    correlation_id: "cor-000000000001",
    audience_json: { kind: "public" },
    payload_json: payload,
    committed_at: createdAt,
  });
}

describe("研究查询与审计端口", () => {
  let dataDir: string;
  let instance: ModuleInstance | undefined;
  let storage: StoragePort;
  let observability: ObservabilityPort;
  const wake = (branchId: string, reason: string, principalId = researcher) =>
    observability.debugWake({ branchId, agentId, reason, operationId, principalId });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "world-prism-research-port-"));
    const host = createFakeHost();
    const signal = new AbortController().signal;
    instance = await storageModuleDefinition.create({
      host, signal, moduleId: storageModuleDefinition.id, config: { dataDir, inlineArtifactMaxBytes: 65_536 },
      realm: "server", ports: {}, scope: {},
    });
    await instance.start(signal);
    storage = instance.port as StoragePort;
    observability = new ObservabilityPort(storage, { timelineLimit: 200 }, host);
    storage.transact((tx) => {
      tx.rows("worlds").put({ world_id: worldId, pack_id: "test", content_version: "1.0.0", created_at: createdAt });
      for (const { branchId, runId } of [left, right]) {
        tx.rows("branches").put({
          branch_id: branchId, world_id: worldId, kind: "experiment", status: "paused",
          parent_branch_id: null, forked_at_world_seq: null, run_id: runId, profile_hash: null, created_at: createdAt,
        });
        tx.rows("runs").put({
          run_id: runId, world_id: worldId, branch_id: branchId, mode: "audit", status: "running",
          run_spec_json: {}, manifest_json: null, manifest_hash: null, contaminated: 0, evidence_complete: 1,
          created_at: createdAt, started_at: createdAt, ended_at: null,
        });
        const branch = tx.branch(branchId);
        branch.table("clock").put({
          world_tick: 1, mode: "paused", seconds_per_tick: 20, run_version: 1, step_target_tick: null,
          updated_at: createdAt,
        });
        branch.table("agent_activations").put({ agent_id: agentId, status: "active", updated_at: createdAt });
      }
    });
  });

  afterEach(async () => {
    try {
      await instance?.dispose();
    } finally {
      instance = undefined;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("比较检查点之后的独立分支，按序返回双侧与单侧结构化事件", () => {
    storage.transact((tx) => {
      putEvent(tx, left.branchId, 1, { old: "left" });
      putEvent(tx, right.branchId, 1, { old: "right" });
      putEvent(tx, left.branchId, 2, { a: 1, b: 2 });
      putEvent(tx, right.branchId, 2, { a: 1, b: 2 });
      tx.run("UPDATE domain_events SET payload_json = ? WHERE branch_id = ? AND world_seq = 2", [
        '{"b":2,"a":1}', right.branchId,
      ]);
      putEvent(tx, left.branchId, 3, { value: "left" });
      putEvent(tx, right.branchId, 3, { value: "right" });
      putEvent(tx, right.branchId, 4, { value: "right-only" });
    });
    expect(observability.branchCompare(left.branchId, right.branchId, 1)).toEqual({
      left: left.branchId, right: right.branchId, atSeq: 1,
      differences: [
        {
          key: "3", kind: "event",
          left: { type: "WorldEvent", payload: { value: "left" }, principalId: agentId },
          right: { type: "WorldEvent", payload: { value: "right" }, principalId: agentId },
        },
        {
          key: "4", kind: "event", left: null,
          right: { type: "WorldEvent", payload: { value: "right-only" }, principalId: agentId },
        },
      ],
    });
    expect(observability.branchCompare(left.branchId, right.branchId, 4).differences).toEqual([]);
  });

  it("遇到损坏的事件 JSON 时返回 invalid-state", () => {
    storage.transact((tx) => {
      putEvent(tx, left.branchId, 1, {});
      tx.run("UPDATE domain_events SET payload_json = ? WHERE branch_id = ? AND world_seq = 1", [
        "{incomplete", left.branchId,
      ]);
    });
    expect(() => observability.branchCompare(left.branchId, right.branchId, 0)).toThrow(expect.objectContaining({
      code: "invalid-state",
      safeMessage: "观测 JSON 文本无法解析",
    }));
  });

  it("同一 operationId 可独立用于不同分支，重试保留各自的审计与污染标记", () => {
    expect(wake(left.branchId, "左侧检查")).toEqual({ ok: true });
    expect(storage.transact((tx) => tx.rows("runs").get({ run_id: right.runId })?.["contaminated"])).toBe(0);
    expect(wake(right.branchId, "右侧检查")).toEqual({ ok: true });
    expect(wake(left.branchId, "左侧检查")).toEqual({ ok: true });
    expect(() => wake(left.branchId, "右侧检查"))
      .toThrow(expect.objectContaining({ code: "idempotency-conflict" }));
    expect(() => wake(left.branchId, "左侧检查", "other-researcher"))
      .toThrow(expect.objectContaining({ code: "idempotency-conflict" }));

    for (const [scope, reason] of [[left, "左侧检查"], [right, "右侧检查"]] as const) {
      const rows = storage.transact((tx) => ({
        run: tx.rows("runs").get({ run_id: scope.runId }),
        triggers: tx.branch(scope.branchId).table("triggers").list(),
        audit: tx.all(
          "SELECT run_id, payload_json FROM lifecycle_events WHERE type = 'DebugWakeRequested' AND branch_id = ?",
          [scope.branchId],
        ),
      }));
      expect(rows.run?.["contaminated"]).toBe(1);
      expect(rows.triggers).toEqual([expect.objectContaining({ agent_id: agentId, source_ref: operationId })]);
      expect(rows.audit).toEqual([{
        run_id: scope.runId, payload_json: canonicalJson({ agentId, reason, operationId, principalId: researcher }),
      }]);
    }
  });

  it("重放存量唤醒审计时保留原记录", () => {
    wake(left.branchId, "存量请求");
    const oldPayload = canonicalJson({ agentId, reason: "存量请求", operationId });
    storage.transact((tx) => {
      tx.run("UPDATE lifecycle_events SET payload_json = ? WHERE run_id = ? AND type = 'DebugWakeRequested'", [
        oldPayload, left.runId,
      ]);
    });
    expect(wake(left.branchId, "存量请求")).toEqual({ ok: true });
    expect(storage.transact((tx) =>
      tx.all("SELECT payload_json FROM lifecycle_events WHERE type = 'DebugWakeRequested'"),
    )).toEqual([{ payload_json: oldPayload }]);
  });

  it("存在调试触发但所属分支的审计缺失时拒绝幂等重放", () => {
    wake(left.branchId, "左侧检查");
    wake(right.branchId, "右侧检查");
    storage.transact((tx) => {
      tx.run("UPDATE lifecycle_events SET payload_json = ? WHERE run_id = ? AND type = 'DebugWakeRequested'", [
        '{"reason":"缺少 operationId"}', left.runId,
      ]);
    });

    expect(() => wake(left.branchId, "左侧检查"))
      .toThrow(expect.objectContaining({ code: "invalid-state", safeMessage: "调试唤醒缺少对应的审计记录" }));
    expect(wake(right.branchId, "右侧检查")).toEqual({ ok: true });
    expect(storage.transact((tx) => tx.branch(left.branchId).table("triggers").count())).toBe(1);
  });

  it("按分支区分调度中的任务、终态和实际模型尝试", () => {
    wake(left.branchId, "待调度");
    storage.transact((tx) => {
      const statuses = ["queued", "deciding", "settling", "completed"];
      for (const [scope, offset] of [[left, 0], [right, statuses.length]] as const) {
        for (const [index, status] of statuses.entries()) {
          tx.rows("turn_runs").put({
            turn_id: `turn-${String(offset + index + 1).padStart(12, "0")}`, agent_turn_index: index + 1,
            run_id: scope.runId, branch_id: scope.branchId, agent_id: agentId, status,
            trigger_ids_json: [], effective_json: [], profile_hash: "fixture",
            controller_epoch: 1, turn_lease_epoch: 1, created_at: createdAt, created_tick: 1,
          });
        }
        tx.rows("model_attempts").put({
          attempt_id: scope.runId.replace("run-", "att-"), llm_call_id: "call-000000000001",
          run_id: scope.runId, work_ref: "turn-000000000002", agent_id: agentId, purpose: "decision",
          model_id: "fixture", connection_id: "fixture", adapter_id: "platform.model-transport.deterministic",
          status: scope === left ? "started" : "succeeded", is_effective: 0, created_at: createdAt,
        });
      }
    });
    expect(observability.debugQueues(left.branchId)).toMatchObject({
      scheduler: { queued: 2, running: 2 },
      modelPool: { queued: null, running: 1, oldestAt: createdAt },
    });
    expect(observability.debugQueues(right.branchId)).toMatchObject({
      scheduler: { queued: 1, running: 2 },
      modelPool: { queued: null, running: 0, oldestAt: null },
    });
  });

  it("在一次事务中批量读取 turn 统计，保留分支、run 与缺失用量的语义", () => {
    const first = "turn-000000000010";
    const second = "turn-000000000011";
    const third = "turn-000000000012";
    const triggers = ["trg-000000000010", "trg-000000000011"] as const;
    storage.transact((tx) => {
      const turns = tx.rows("turn_runs");
      const base = {
        run_id: left.runId, branch_id: left.branchId, agent_id: agentId, status: "queued",
        effective_json: [], profile_hash: "fixture", controller_epoch: 1, turn_lease_epoch: 1, created_tick: 1,
      };
      turns.put({
        ...base, turn_id: first, agent_turn_index: 1, created_at: createdAt,
        trigger_ids_json: [...triggers, triggers[0]],
      });
      turns.put({
        ...base, turn_id: second, agent_turn_index: 2, created_at: "2026-01-01T00:00:01.000Z", trigger_ids_json: [],
      });
      turns.put({
        ...base, turn_id: third, agent_turn_index: 3, created_at: "2026-01-01T00:00:02.000Z", trigger_ids_json: [],
      });
      for (const branchId of [left.branchId, right.branchId]) {
        for (const triggerId of triggers) {
          tx.branch(branchId).table("triggers").put({
            trigger_id: triggerId, agent_id: agentId, kind: branchId === left.branchId ? "debug" : "patrol",
            priority: 100, source_ref: operationId, created_tick: 1, dedupe_key: triggerId, consumed_by_turn_id: null,
          });
        }
      }
      const attempts = tx.rows("model_attempts");
      const attempt = {
        llm_call_id: "call-000000000001", agent_id: agentId, purpose: "decision", model_id: "fixture",
        connection_id: "fixture", adapter_id: "platform.model-transport.deterministic",
        status: "succeeded", is_effective: 0, created_at: createdAt,
      };
      const usage = { inputTokens: 5, outputTokens: 2 };
      attempts.put({ ...attempt, attempt_id: "att-000000000001", run_id: left.runId, work_ref: first, usage_json: usage });
      attempts.put({ ...attempt, attempt_id: "att-000000000002", run_id: left.runId, work_ref: first, usage_json: usage });
      attempts.put({ ...attempt, attempt_id: "att-000000000003", run_id: left.runId, work_ref: second, usage_json: null });
      attempts.put({ ...attempt, attempt_id: "att-000000000004", run_id: right.runId, work_ref: first, usage_json: usage });
      const toolCalls = tx.rows("tool_calls");
      const tool = {
        turn_id: first, agent_id: agentId, provider_call_id: "call-fixture", tool_id: "fixture",
        tool_version: "1", binding_id: "fixture", status: "settled", args_hash: "fixture", created_at: createdAt,
      };
      toolCalls.put({ ...tool, tool_call_id: "tool-000000000001", run_id: left.runId, attempt_id: "att-000000000001" });
      toolCalls.put({ ...tool, tool_call_id: "tool-000000000002", run_id: right.runId, attempt_id: "att-000000000004" });
    });

    const transactions = vi.spyOn(storage, "transact");
    try {
      expect(observability.turns({ branchId: left.branchId }).turns).toMatchObject([
        { turnId: third, triggerKinds: [], modelCalls: 0, toolCalls: 0, tokens: { input: null, output: null } },
        { turnId: second, triggerKinds: [], modelCalls: 1, toolCalls: 0, tokens: { input: null, output: null } },
        { turnId: first, triggerKinds: ["debug", "debug"], modelCalls: 2, toolCalls: 1, tokens: { input: 10, output: 4 } },
      ]);
      expect(transactions).toHaveBeenCalledTimes(1);
    } finally {
      transactions.mockRestore();
    }
  });
});
