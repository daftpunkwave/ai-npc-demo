/**
 * 核心职责：验证 trace_spans 按保留期裁剪后，依赖跨度与生命周期审计的读取方仍按契约工作：
 *   turn 详情的证据完整、只失去 traceId 关联，过期 trace 返回 not-found，未过期 trace 不受影响，
 *   调试唤醒的幂等重放与生命周期时间线仍能读到保留的审计。
 * 交互契约：先用未配置保留期的存储写入夹具，再以配置了 30 天保留期的存储实例重新打开同一数据目录，
 *   由模块启动时的首轮清理完成裁剪；观测端口按宿主同样的方式绑定数据源。
 * 约束与禁忌：不启动 HTTP、模型或调度器；不直接调用清理实现，只经模块生命周期触发。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObservabilitySources } from "@world-prism/app-server";
import type { HostServices, Json, ModuleInstance, StoragePort, TurnDetail } from "@world-prism/contracts";
import { clockConfigSchema, createClockPort } from "@world-prism/mod-game-clock-controlled";
import { ObservabilityPort } from "@world-prism/mod-platform-observability-sqlite";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { listLifecycleTimeline } from "@world-prism/module-sdk";
import { createFakeHost } from "./authority-support";

const worldId = "wld-retention";
const branchId = "br-000000000001";
const runId = "run-000000000001";
const agentId = "human-independent";
const createdAt = "2026-01-01T00:00:00.000Z";
const operationId = "op-000000000001";
const researcher = "researcher-fixture";
const pruneAt = "2026-03-01T00:00:00.000Z";

/** 一个 turn 的夹具：两条阶段跨度落在同一 trace，决定正文归 artifact。 */
interface TurnFixture {
  readonly turnId: string;
  readonly traceId: string;
  readonly spanIds: readonly [string, string];
  readonly artifactId: string;
  readonly startedAt: string;
}

const oldTurn: TurnFixture = {
  turnId: "turn-000000000001", traceId: "trc-000000000001", spanIds: ["spn-000000000001", "spn-000000000002"],
  artifactId: "art-000000000001", startedAt: "2026-01-05T08:00:00.000Z",
};
const recentTurn: TurnFixture = {
  turnId: "turn-000000000002", traceId: "trc-000000000002", spanIds: ["spn-000000000003", "spn-000000000004"],
  artifactId: "art-000000000002", startedAt: "2026-02-25T08:00:00.000Z",
};

function stageEntries(turn: TurnFixture): Json[] {
  return [
    { stage: "turn.claim", spanId: turn.spanIds[0], requested: null, resolved: null, status: "applied", reason: null, effective: null },
    {
      stage: "turn.decision", spanId: turn.spanIds[1], requested: null, resolved: null, status: "applied", reason: null,
      effective: { artifactId: turn.artifactId },
    },
  ];
}

async function openStorage(dataDir: string, host: HostServices, config: Json): Promise<ModuleInstance> {
  const signal = new AbortController().signal;
  const instance = await storageModuleDefinition.create({
    host, signal, moduleId: storageModuleDefinition.id, config, realm: "server", ports: {}, scope: {},
  });
  await instance.start(signal);
  return instance;
}

function bindObservability(storage: StoragePort, host: HostServices): ObservabilityPort {
  const observability = new ObservabilityPort(storage, { timelineLimit: 200 }, host);
  const clock = createClockPort(storage, clockConfigSchema.parse({}), () => host.nowIso());
  observability.bind(createObservabilitySources({
    storage,
    host,
    worldTick: (tx, scopedBranchId) => clock.readInTransaction(tx, scopedBranchId).worldTick,
    worldIn: () => {
      throw new Error("保留期读取用例不读取角色位置");
    },
  }));
  return observability;
}

function seedTurn(storage: StoragePort, observability: ObservabilityPort, turn: TurnFixture, index: number): void {
  storage.transact((tx) => {
    tx.rows("turn_runs").put({
      turn_id: turn.turnId, agent_turn_index: index, run_id: runId, branch_id: branchId, agent_id: agentId,
      status: "completed", trigger_ids_json: [], effective_json: stageEntries(turn), profile_hash: "fixture",
      controller_epoch: 1, turn_lease_epoch: 1, created_at: turn.startedAt, created_tick: index,
    });
    tx.rows("artifacts").put({
      artifact_id: turn.artifactId, run_id: runId, kind: "decision", content_hash: `hash-${turn.turnId}`,
      mime: "application/json", byte_size: 0, storage: "inline",
      body: new TextEncoder().encode(JSON.stringify({ decision: { kind: "wait", turnId: turn.turnId } })),
      file_path: null, redaction: "raw", redacted_from: null, created_at: turn.startedAt,
    });
  });
  const startMs = Date.parse(turn.startedAt);
  for (const [offset, spanId] of turn.spanIds.entries()) {
    observability.recordSpan({
      spanId, traceId: turn.traceId, parentSpanId: null, runId, branchId, agentId, turnId: turn.turnId,
      moduleId: null, moduleVersion: null, name: offset === 0 ? "turn.claim" : "turn.decision", status: "ok",
      startMs: startMs + offset * 1_000, endMs: startMs + offset * 1_000 + 500, attrs: stageEntries(turn)[offset] ?? null,
    });
  }
}

describe("trace_spans 保留期裁剪后的读取方", () => {
  let dataDir: string;
  let instance: ModuleInstance | undefined;
  let oldTurnBefore: TurnDetail;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "world-prism-retention-readers-"));
    const host = createFakeHost();
    instance = await openStorage(dataDir, host, { dataDir, inlineArtifactMaxBytes: 65_536 });
    const storage = instance.port as StoragePort;
    const observability = bindObservability(storage, host);
    storage.transact((tx) => {
      tx.rows("worlds").put({ world_id: worldId, pack_id: "test", content_version: "1.0.0", created_at: createdAt });
      tx.rows("branches").put({
        branch_id: branchId, world_id: worldId, kind: "experiment", status: "paused", parent_branch_id: null,
        forked_at_world_seq: null, run_id: runId, profile_hash: null, created_at: createdAt,
      });
      tx.rows("runs").put({
        run_id: runId, world_id: worldId, branch_id: branchId, mode: "audit", status: "running", run_spec_json: {},
        manifest_json: null, manifest_hash: null, contaminated: 0, evidence_complete: 1, created_at: createdAt,
        started_at: createdAt, ended_at: null,
      });
      const branch = tx.branch(branchId);
      branch.table("clock").put({
        world_tick: 1, mode: "paused", seconds_per_tick: 20, run_version: 1, step_target_tick: null, updated_at: createdAt,
      });
      branch.table("agent_activations").put({ agent_id: agentId, status: "active", updated_at: createdAt });
    });
    seedTurn(storage, observability, oldTurn, 1);
    seedTurn(storage, observability, recentTurn, 2);
    oldTurnBefore = observability.turn(oldTurn.turnId);
    // 调试唤醒的审计写在 lifecycle_events；该表不可轮转，重放校验依赖这条记录。
    observability.debugWake({ branchId, agentId, reason: "检查旧 turn", operationId, principalId: researcher });
    await instance.dispose();
    instance = undefined;
  });

  afterEach(async () => {
    try {
      await instance?.dispose();
    } finally {
      instance = undefined;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("裁剪只移除过期跨度，turn 证据、调试审计与幂等重放保持可用", async () => {
    expect(oldTurnBefore.traceId).toBe(oldTurn.traceId);
    const host = { ...createFakeHost(), nowIso: () => pruneAt };
    instance = await openStorage(dataDir, host, {
      dataDir, inlineArtifactMaxBytes: 65_536, retentionDays: { trace_spans: 30 },
    });
    const storage = instance.port as StoragePort;
    await vi.waitFor(() => {
      expect(storage.transact((tx) => tx.rows("lifecycle_events").count({ type: "StorageRetentionPruned" }))).toBe(1);
    });
    const observability = bindObservability(storage, host);

    expect(storage.transact((tx) => tx.all("SELECT span_id FROM trace_spans ORDER BY span_id").map((row) => row["span_id"])))
      .toEqual([...recentTurn.spanIds]);

    // turn 详情的阶段、决定与 artifact 来自 turn_runs 与 artifacts，裁剪后只失去指向已删除 trace 的 traceId。
    const after = observability.turn(oldTurn.turnId);
    expect(after).toEqual({ ...oldTurnBefore, traceId: null });
    expect(after.decision).toEqual({ kind: "wait", turnId: oldTurn.turnId });
    expect(after.stages.map((stage) => stage.spanId)).toEqual([...oldTurn.spanIds]);

    expect(() => observability.trace(oldTurn.traceId)).toThrow(expect.objectContaining({ code: "not-found" }));
    expect(observability.turn(recentTurn.turnId).traceId).toBe(recentTurn.traceId);
    expect(observability.trace(recentTurn.traceId).root.spanId).toBe(recentTurn.spanIds[0]);

    expect(observability.debugWake({ branchId, agentId, reason: "检查旧 turn", operationId, principalId: researcher }))
      .toEqual({ ok: true });
    expect(() => observability.debugWake({ branchId, agentId, reason: "换了原因", operationId, principalId: researcher }))
      .toThrow(expect.objectContaining({ code: "idempotency-conflict" }));
    expect(storage.transact((tx) => listLifecycleTimeline(tx, { branchId, limit: 10, order: "asc" }))
      .map((event) => event.type)).toEqual(["DebugWakeRequested"]);
    expect(storage.transact((tx) => tx.rows("runs").get({ run_id: runId })?.["contaminated"])).toBe(1);
  });
});
