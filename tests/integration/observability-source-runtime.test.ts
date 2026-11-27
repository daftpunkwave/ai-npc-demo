/**
 * 核心职责：在真实 SQLite 上锁定 agent-runtime 为观测数据源提供的查询：turn 记录与关联证据、调度与整理队列、
 *   Agent 运行时状态、记忆水位与行版本、观察分页以及调试触发的列到字段映射。
 * 交互契约：依赖存储模块执行真实迁移；夹具按 agent-runtime 与模型池的写入形态预置行。
 *   turn_runs 的列清单与观测记录字段逐一对照：新增或改名列时本文件失败，由数据所有者决定是否暴露给观测。
 * 约束与禁忌：不启动宿主、模型或调度器；损坏的存储行必须以 invalid-state 失败而不是被跳过。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  countTurnToolCalls,
  enqueueDebugTrigger,
  findDebugTriggerAgent,
  isAgentActive,
  listAgentRuntimeStates,
  listMemoryRecordVersions,
  listObservationPage,
  listPendingMaintenance,
  listStartedModelAttemptTimes,
  listTurnModelAttempts,
  listTurnModelUsages,
  listTurnRuns,
  listTurnToolCalls,
  listTurnTriggerKinds,
  readMemoryWatermark,
  readPerceptionRevision,
  readSchedulerQueue,
  readTurnRun,
} from "@world-prism/agent-runtime";
import type { StoragePort, StorageRow, StorageTransaction } from "@world-prism/contracts";
import type { ObservedTurnRun } from "@world-prism/module-sdk";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { createFakeHost } from "./authority-support";

const worldId = "wld-000000000001";
const branchId = "br-000000000001";
const runId = "run-000000000001";
const agentId = "npc-wenzhao";
const createdAt = "2026-01-01T00:00:00.000Z";

const resources: { readonly dispose: () => Promise<void>; readonly dataDir: string }[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.dispose();
    rmSync(resource.dataDir, { recursive: true, force: true });
  }
});

async function openStorage(): Promise<StoragePort> {
  const dataDir = mkdtempSync(join(tmpdir(), "observability-source-runtime-"));
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host: createFakeHost(),
    signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  resources.push({ dispose: () => instance.dispose(), dataDir });
  const storage = instance.port as StoragePort;
  storage.transact((tx) => {
    tx.rows("worlds").put({ world_id: worldId, pack_id: "test", content_version: "1.0.0", created_at: createdAt });
    tx.rows("branches").put({
      branch_id: branchId, world_id: worldId, kind: "experiment", status: "paused",
      parent_branch_id: null, forked_at_world_seq: null, run_id: runId, profile_hash: null, created_at: createdAt,
    });
    tx.rows("runs").put({
      run_id: runId, world_id: worldId, branch_id: branchId, mode: "audit", status: "running",
      run_spec_json: {}, manifest_json: null, manifest_hash: null, contaminated: 0, evidence_complete: 1,
      created_at: createdAt, started_at: createdAt, ended_at: null,
    });
  });
  return storage;
}

/** turn_runs 的列与观测记录字段的对应；观测不需要的列显式列在 unobserved 中。 */
const turnRunColumns = {
  observed: {
    turn_id: "turnId",
    run_id: "runId",
    branch_id: "branchId",
    agent_id: "agentId",
    agent_turn_index: "agentTurnIndex",
    status: "status",
    trigger_ids_json: "triggerIds",
    input_frontier_json: "inputFrontier",
    memory_revision: "memoryRevision",
    terminal_reason: "terminalReason",
    effective_json: "effective",
    created_at: "createdAt",
    ended_at: "endedAt",
  } satisfies Readonly<Record<string, keyof ObservedTurnRun>>,
  unobserved: [
    "profile_hash", "controller_epoch", "turn_lease_epoch", "lease_expires_at", "started_at", "created_tick",
  ],
} as const;

function turnRunRow(turnId: string, overrides: Readonly<Record<string, StorageRow[string]>> = {}): StorageRow {
  return {
    turn_id: turnId, run_id: runId, branch_id: branchId, agent_id: agentId, agent_turn_index: 1,
    status: "completed", trigger_ids_json: [], input_frontier_json: null, memory_revision: null,
    profile_hash: "profile", controller_epoch: 1, turn_lease_epoch: 1, lease_expires_at: null,
    terminal_reason: null, effective_json: [], created_at: createdAt, started_at: null, ended_at: null,
    created_tick: 0, ...overrides,
  };
}

function putTrigger(tx: StorageTransaction, triggerId: string, kind: string, consumedBy: string | null): void {
  tx.branch(branchId).table("triggers").put({
    trigger_id: triggerId, agent_id: agentId, kind, priority: 10, source_ref: "evt-000000000001",
    created_tick: 0, dedupe_key: triggerId, consumed_by_turn_id: consumedBy,
  });
}

function putAttempt(
  tx: StorageTransaction,
  attempt: { readonly id: string; readonly turnId: string; readonly status: string; readonly usage: StorageRow[string]; readonly at?: string },
): void {
  tx.rows("model_attempts").put({
    attempt_id: attempt.id, llm_call_id: "call-000000000001", run_id: runId, work_ref: attempt.turnId,
    agent_id: agentId, evaluator_id: null, purpose: "decision", model_id: "model-a", connection_id: "conn-a",
    adapter_id: "platform.model-transport.deterministic", status: attempt.status, is_effective: 1,
    request_artifact_id: "art-000000000001", response_artifact_id: null, usage_json: attempt.usage,
    timings_json: null, error_json: attempt.status === "failed" ? { kind: "timeout" } : null,
    created_at: attempt.at ?? createdAt,
  });
}

describe("agent-runtime 提供的 turn 证据查询", () => {
  it("turn_runs 的每一列都已决定是否进入观测记录", async () => {
    const storage = await openStorage();
    const columns = storage.transact((tx) => tx.all("PRAGMA table_info(turn_runs)")).map((row) => String(row["name"]));
    expect([...columns].sort()).toEqual(
      [...Object.keys(turnRunColumns.observed), ...turnRunColumns.unobserved].sort(),
    );
  });

  it("列表与单个 turn 两条读取路径把各列解码为相同的观测记录", async () => {
    const storage = await openStorage();
    const turnId = "turn-000000000001";
    storage.transact((tx) => tx.rows("turn_runs").put(turnRunRow(turnId, {
      agent_turn_index: 3,
      status: "failed",
      trigger_ids_json: ["trg-000000000001"],
      input_frontier_json: { worldSeq: 4 },
      memory_revision: 2,
      terminal_reason: "turn-deadline",
      effective_json: [{ stage: "turn.decision" }],
      ended_at: "2026-01-01T00:00:09.000Z",
    })));
    const expected: ObservedTurnRun = {
      turnId, runId, branchId, agentId, agentTurnIndex: 3, status: "failed", triggerIds: ["trg-000000000001"],
      inputFrontier: { worldSeq: 4 }, memoryRevision: 2, terminalReason: "turn-deadline",
      effective: [{ stage: "turn.decision" }], createdAt, endedAt: "2026-01-01T00:00:09.000Z",
    };
    expect(Object.keys(expected).sort()).toEqual(Object.values(turnRunColumns.observed).sort());
    expect(storage.transact((tx) => listTurnRuns(tx, { branchId, limit: 10 }))).toEqual([expected]);
    expect(storage.transact((tx) => readTurnRun(tx, turnId))).toEqual(expected);
    expect(storage.transact((tx) => readTurnRun(tx, "turn-000000000099"))).toBeNull();
  });

  it("turn 列表按世界、run、Agent 与状态筛选并按创建时间倒序截取", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      const turns = tx.rows("turn_runs");
      turns.put(turnRunRow("turn-000000000001", { created_at: "2026-01-01T00:00:01.000Z" }));
      turns.put(turnRunRow("turn-000000000002", { created_at: "2026-01-01T00:00:02.000Z", status: "queued" }));
      turns.put(turnRunRow("turn-000000000003", { created_at: "2026-01-01T00:00:03.000Z" }));
    });
    const ids = (filter: Parameters<typeof listTurnRuns>[1]) =>
      storage.transact((tx) => listTurnRuns(tx, filter)).map((turn) => turn.turnId);
    expect(ids({ worldId, limit: 2 })).toEqual(["turn-000000000003", "turn-000000000002"]);
    expect(ids({ worldId: "wld-000000000002", limit: 10 })).toEqual([]);
    expect(ids({ runId, agentId, status: "completed", limit: 10 })).toEqual(["turn-000000000003", "turn-000000000001"]);
  });

  it("损坏的触发 ID 列以 invalid-state 拒绝", async () => {
    const storage = await openStorage();
    storage.transact((tx) => tx.rows("turn_runs").put(turnRunRow("turn-000000000001", { trigger_ids_json: "not-json" })));
    expect(() => storage.transact((tx) => listTurnRuns(tx, { branchId, limit: 10 }))).toThrow(expect.objectContaining({
      code: "invalid-state",
      safeMessage: "存储表 turn_runs 的列 trigger_ids_json 不是文本数组",
    }));
  });

  it("批量读取触发种类、工具调用数与各次模型尝试用量，模型尝试与工具调用逐列解码", async () => {
    const storage = await openStorage();
    const first = "turn-000000000001";
    const second = "turn-000000000002";
    storage.transact((tx) => {
      tx.rows("turn_runs").put(turnRunRow(first, { trigger_ids_json: ["trg-000000000002", "trg-000000000001"] }));
      tx.rows("turn_runs").put(turnRunRow(second));
      putTrigger(tx, "trg-000000000001", "debug", first);
      putTrigger(tx, "trg-000000000002", "patrol", first);
      putAttempt(tx, { id: "att-000000000001", turnId: first, status: "succeeded", usage: { inputTokens: 5, outputTokens: 2 } });
      putAttempt(tx, { id: "att-000000000002", turnId: first, status: "failed", usage: null, at: "2026-01-01T00:00:01.000Z" });
      tx.rows("tool_calls").put({
        tool_call_id: "tc-000000000001", run_id: runId, turn_id: first, attempt_id: "att-000000000001",
        agent_id: agentId, provider_call_id: "call-1", tool_id: "world.inspect", tool_version: "1",
        binding_id: "binding", status: "settled", args_hash: "hash", operation_id: "op-000000000001",
        command_id: "cmd-000000000001", execution_status: "ok", raw_artifact_id: "art-000000000002",
        view_artifact_id: "art-000000000003", created_at: createdAt, settled_at: createdAt,
      });
    });
    const turnIds = [first, second];
    expect(storage.transact((tx) => listTurnTriggerKinds(tx, turnIds))).toEqual(new Map([[first, ["debug", "patrol"]]]));
    expect(storage.transact((tx) => countTurnToolCalls(tx, turnIds))).toEqual(new Map([[first, 1]]));
    const usages = storage.transact((tx) => listTurnModelUsages(tx, turnIds));
    expect([...usages.keys()]).toEqual([first]);
    // 用量按尝试逐条给出，次序不作约定；未记录用量的尝试为 null 而不是被省略。
    expect(usages.get(first)).toHaveLength(2);
    expect(usages.get(first)).toEqual(expect.arrayContaining([{ inputTokens: 5, outputTokens: 2 }, null]));
    expect(storage.transact((tx) => listTurnModelAttempts(tx, runId, first))).toEqual([
      {
        attemptId: "att-000000000001", purpose: "decision", modelId: "model-a", status: "succeeded", isEffective: true,
        requestArtifactId: "art-000000000001", responseArtifactId: null,
        usage: { inputTokens: 5, outputTokens: 2 }, error: null,
      },
      {
        attemptId: "att-000000000002", purpose: "decision", modelId: "model-a", status: "failed", isEffective: true,
        requestArtifactId: "art-000000000001", responseArtifactId: null, usage: null, error: { kind: "timeout" },
      },
    ]);
    expect(storage.transact((tx) => listTurnToolCalls(tx, runId, first))).toEqual([{
      toolCallId: "tc-000000000001", toolId: "world.inspect", executionStatus: "ok", commandId: "cmd-000000000001",
      rawArtifactId: "art-000000000002", viewArtifactId: "art-000000000003", operationId: "op-000000000001",
    }]);
    expect(storage.transact((tx) => listTurnTriggerKinds(tx, []))).toEqual(new Map());
  });

  it("调度队列、进行中的模型尝试与未完成的整理任务按分支统计", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      tx.rows("turn_runs").put(turnRunRow("turn-000000000001", { status: "queued" }));
      tx.rows("turn_runs").put(turnRunRow("turn-000000000002", { status: "deciding" }));
      tx.rows("turn_runs").put(turnRunRow("turn-000000000003", { status: "completed" }));
      putTrigger(tx, "trg-000000000001", "patrol", null);
      putTrigger(tx, "trg-000000000002", "patrol", "turn-000000000001");
      putAttempt(tx, { id: "att-000000000001", turnId: "turn-000000000002", status: "started", usage: null });
      putAttempt(tx, { id: "att-000000000002", turnId: "turn-000000000003", status: "succeeded", usage: null });
      const tasks = [
        ["mnt-000000000001", "queued", "2026-01-01T00:00:01.000Z"],
        ["mnt-000000000002", "leased", "2026-01-01T00:00:02.000Z"],
        ["mnt-000000000003", "completed", "2026-01-01T00:00:03.000Z"],
      ] as const;
      for (const [maintenanceId, status, at] of tasks) {
        tx.rows("maintenance_runs").put({
          maintenance_id: maintenanceId, run_id: runId, branch_id: branchId, agent_id: agentId,
          module_id: "agent.memory.ledger", status, trigger: "day-passed", due_tick: 0, observation_seq_through: 0,
          task_json: {}, base_revision: null, lease_epoch: 0, lease_expires_at: null, error_json: null,
          created_at: at, ended_at: null,
        });
      }
    });
    expect(storage.transact((tx) => readSchedulerQueue(tx, branchId))).toEqual({ queued: 2, running: 1 });
    expect(storage.transact((tx) => listStartedModelAttemptTimes(tx, branchId))).toEqual([createdAt]);
    expect(storage.transact((tx) => listPendingMaintenance(tx, branchId))).toEqual(expect.arrayContaining([
      { status: "queued", createdAt: "2026-01-01T00:00:01.000Z" },
      { status: "leased", createdAt: "2026-01-01T00:00:02.000Z" },
    ]));
    expect(storage.transact((tx) => listPendingMaintenance(tx, branchId))).toHaveLength(2);
  });
});

describe("agent-runtime 提供的 Agent 状态查询", () => {
  it("运行时状态合并激活、控制权、最近 turn 与感知水位，缺失项为 null", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      const branch = tx.branch(branchId);
      branch.table("agent_activations").put({ agent_id: agentId, status: "active", updated_at: createdAt });
      branch.table("agent_activations").put({ agent_id: "human-independent", status: "dormant", updated_at: createdAt });
      branch.table("controller_leases").put({
        agent_id: agentId, controller_kind: "human", controller_principal_id: "console-1", controller_epoch: 2,
        lease_expires_at: null,
      });
      branch.table("perception_state").put({
        agent_id: agentId, module_id: "agent.perception.local", revision: 4, scanned_through_seq: 7, state_json: {},
      });
      tx.rows("turn_runs").put(turnRunRow("turn-000000000001", { agent_turn_index: 1, status: "completed" }));
      tx.rows("turn_runs").put(turnRunRow("turn-000000000002", { agent_turn_index: 2, status: "deciding" }));
    });
    expect(storage.transact((tx) => listAgentRuntimeStates(tx, branchId))).toEqual([
      {
        agentId: "human-independent", activationStatus: "dormant", controllerKind: null,
        latestTurnStatus: null, scannedThroughSeq: null,
      },
      {
        agentId, activationStatus: "active", controllerKind: "human",
        latestTurnStatus: "deciding", scannedThroughSeq: 7,
      },
    ]);
    expect(storage.transact((tx) => readPerceptionRevision(tx, branchId, agentId))).toBe(4);
    expect(storage.transact((tx) => readPerceptionRevision(tx, branchId, "human-independent"))).toBeNull();
  });

  it("记忆水位与行版本逐列解码，损坏的行版本以 invalid-state 拒绝", async () => {
    const storage = await openStorage();
    const memoryRow = (overrides: Readonly<Record<string, StorageRow[string]>>): StorageRow => ({
      agent_id: agentId, memory_id: "mem-000000000001", row_version: 1, module_id: "agent.memory.ledger",
      kind: "episodic", tier: "short", status: "active", epistemic: "verified-event", release_policy_id: "policy-1",
      valid_from_tick: 2, valid_until_tick: null, created_revision: 1, retired_revision: null, strength: 1,
      salience: 0, recall_count: 0, tags_json: [], source_observation_ids_json: ["obs-000000000001"],
      content_json: { summaryZh: "记录", _lastReinforcedTick: 2 }, ...overrides,
    });
    storage.transact((tx) => {
      const branch = tx.branch(branchId);
      branch.table("memory_watermarks").put({
        agent_id: agentId, module_id: "agent.memory.ledger", revision: 2, observation_seq_consumed: 5,
        durable_through_seq: 5, derived_through_seq: 5, derived_through_tick: 3,
      });
      branch.table("memory_records").put(memoryRow({ row_version: 2, created_revision: 2, valid_until_tick: 9 }));
      branch.table("memory_records").put(memoryRow({ retired_revision: 2 }));
    });
    expect(storage.transact((tx) => readMemoryWatermark(tx, branchId, agentId)))
      .toEqual({ revision: 2, observationSeqConsumed: 5, derivedThroughTick: 3 });
    expect(storage.transact((tx) => readMemoryWatermark(tx, branchId, "human-independent"))).toBeNull();
    expect(storage.transact((tx) => listMemoryRecordVersions(tx, branchId, agentId))).toEqual([
      {
        memoryId: "mem-000000000001", rowVersion: 1, kind: "episodic", status: "active", epistemic: "verified-event",
        releasePolicyId: "policy-1", validFromTick: 2, validUntilTick: null, createdRevision: 1, retiredRevision: 2,
        sourceObservationIds: ["obs-000000000001"], content: { summaryZh: "记录", _lastReinforcedTick: 2 },
      },
      {
        memoryId: "mem-000000000001", rowVersion: 2, kind: "episodic", status: "active", epistemic: "verified-event",
        releasePolicyId: "policy-1", validFromTick: 2, validUntilTick: 9, createdRevision: 2, retiredRevision: null,
        sourceObservationIds: ["obs-000000000001"], content: { summaryZh: "记录", _lastReinforcedTick: 2 },
      },
    ]);
    storage.transact((tx) => tx.branch(branchId).table("memory_records")
      .put(memoryRow({ memory_id: "mem-000000000002", created_revision: "invalid" })));
    expect(() => storage.transact((tx) => listMemoryRecordVersions(tx, branchId, agentId)))
      .toThrow(expect.objectContaining({ code: "invalid-state" }));
  });

  it("观察分页按序号截取并逐列解码", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      for (const seq of [1, 2, 3]) {
        tx.branch(branchId).table("observations").put({
          agent_id: agentId, observation_seq: seq, observation_id: `obs-00000000000${String(seq)}`,
          source_event_ids_json: [`evt-00000000000${String(seq)}`], source_observation_ids_json: [],
          occurred_at_tick: seq, sensed_at_tick: seq + 1, known_at_tick: seq + 2, channel: "party",
          epistemic: "witnessed", confidence: 0.5, release_policy_id: "policy-1",
          content_json: { eventType: "MetersChanged" },
        });
      }
    });
    expect(storage.transact((tx) => listObservationPage(tx, { branchId, agentId, afterSeq: 1, limit: 1 }))).toEqual([{
      observationId: "obs-000000000002", observationSeq: 2, sourceEventIds: ["evt-000000000002"], sourceObservationIds: [],
      occurredAtTick: 2, sensedAtTick: 3, knownAtTick: 4, channel: "party", epistemic: "witnessed", confidence: 0.5,
      releasePolicyId: "policy-1", content: { eventType: "MetersChanged" },
    }]);
  });

  it("调试触发按 operationId 去重登记，并只对激活的 Agent 生效", async () => {
    const storage = await openStorage();
    storage.transact((tx) => {
      tx.branch(branchId).table("agent_activations").put({ agent_id: agentId, status: "active", updated_at: createdAt });
      tx.branch(branchId).table("agent_activations").put({ agent_id: "human-independent", status: "dormant", updated_at: createdAt });
    });
    expect(storage.transact((tx) => isAgentActive(tx, branchId, agentId))).toBe(true);
    expect(storage.transact((tx) => isAgentActive(tx, branchId, "human-independent"))).toBe(false);
    expect(storage.transact((tx) => findDebugTriggerAgent(tx, branchId, "op-000000000001"))).toBeNull();
    storage.transact((tx) => enqueueDebugTrigger(tx, {
      branchId, triggerId: "trg-000000000001", agentId, operationId: "op-000000000001", createdTick: 6,
    }));
    expect(storage.transact((tx) => findDebugTriggerAgent(tx, branchId, "op-000000000001"))).toBe(agentId);
    expect(storage.transact((tx) => tx.branch(branchId).table("triggers").list())).toEqual([{
      branch_id: branchId, trigger_id: "trg-000000000001", agent_id: agentId, kind: "debug", priority: 100,
      source_ref: "op-000000000001",
      created_tick: 6, dedupe_key: "debug:op-000000000001", consumed_by_turn_id: null,
    }]);
  });
});
