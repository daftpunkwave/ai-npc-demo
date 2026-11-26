/**
 * 核心职责：验证整理模型的预算、失败恢复、反思水位和记忆版本更新。
 * 交互契约：使用真实 MemoryHost、SQLite 与可观测模型端口，不访问网络。
 * 约束与禁忌：禁止伪造成功水位或只检查模型请求而忽略持久化结果。
 */
import { describe, expect, it, vi } from "vitest";
import type { ModelWorkScope, RunModelPort } from "@world-prism/module-sdk";
import { memoryLedgerModuleDefinition, memoryLayeredHybridModuleDefinition, memoryStreamReflectionModuleDefinition } from "@world-prism/mod-agent-memory-ledger";
import { createMemoryHarness, insertObservation, memoryAgentId, memoryBranchId, memoryQuery } from "./memory-support";
import { isDisclosable } from "@world-prism/agent-runtime";
import { memoryModelRoute, modelResponse, oneAttemptModel, startVariantHost } from "./memory-variants-support";

describe("maintenance model persistence", () => {
  it("runs legacy M1 rules without a memory-maintenance model mount", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    const route = vi.fn<RunModelPort["route"]>(() => { throw new Error("no memory-maintenance mount"); });
    const call = vi.fn<RunModelPort["call"]>();
    const host = await startVariantHost(harness, { model: { route, call } });
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24); await host.runDueMaintenance(24);
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(24);
      expect(route).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    } finally { await host.dispose(); await harness.dispose(); }
  });

  it("does not repeat a committed short-memory merge on model retry", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const call = vi.fn<RunModelPort["call"]>().mockRejectedValueOnce(new Error("provider timeout")).mockResolvedValue(modelResponse({ beliefOps: [], currentConcerns: null, intents: [] }));
    const host = await startVariantHost(harness, { model: oneAttemptModel(call) });
    try {
      for (let sequence = 1; sequence <= 8; sequence += 1) insertObservation(harness, { sequence, tick: 24, eventType: "RumorSpread", summary: "short rumor" });
      insertObservation(harness, { sequence: 9, tick: 24, eventType: "AgreementBreached", summary: "major change", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 10, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24); await host.runDueMaintenance(24);
      const readMerged = () => harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId }).filter((row) => row["retired_revision"] === null && JSON.stringify(row["content_json"]).includes("mergedCount")));
      const merged = readMerged();
      expect(merged).toHaveLength(1); expect(merged[0]).toMatchObject({ tier: "long", salience: 1 });
      await host.runDueMaintenance(24);
      expect(call).toHaveBeenCalledTimes(2); expect(readMerged()).toEqual(merged);
    } finally { await host.dispose(); await harness.dispose(); }
  });

  it("rejects a late model result after another host recovers the lease", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    let announce: (work: ModelWorkScope) => void = () => { throw new Error("work gate not initialized"); };
    let release: () => void = () => { throw new Error("result gate not initialized"); };
    const entered = new Promise<ModelWorkScope>((resolve) => { announce = resolve; });
    const result = new Promise<void>((resolve) => { release = resolve; });
    const call = vi.fn<RunModelPort["call"]>()
      .mockImplementationOnce(async (work) => { announce(work); await result; return modelResponse({ beliefOps: [], currentConcerns: null, intents: [] }); })
      .mockResolvedValue(modelResponse({ beliefOps: [], currentConcerns: null, intents: [] }));
    const options = { model: oneAttemptModel(call) };
    const first = await startVariantHost(harness, options);
    let second: Awaited<ReturnType<typeof startVariantHost>> | undefined;
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "breach", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await first.ingestAll(24);
      const pending = first.runDueMaintenance(24);
      const work = await entered;
      expect(work.fence()).toBe(true);
      second = await startVariantHost(harness, options);
      expect(work.fence()).toBe(false);
      await second.runDueMaintenance(24);
      const committed = second.watermark(memoryAgentId);
      release(); await pending;
      expect(second.watermark(memoryAgentId)).toEqual(committed);
      expect(committed.derivedThroughTick).toBe(24);
      expect(harness.storage.transact((tx) => tx.rows("maintenance_runs").list({ agent_id: memoryAgentId }))).toEqual([expect.objectContaining({ status: "completed", lease_epoch: 2 })]);
    } finally { release(); await second?.dispose(); await first.dispose(); await harness.dispose(); }
  });
  it.each([{ reflections: [] }, { reflections: [{ statement: "unsupported", evidenceIds: ["mem-000000000098", "mem-000000000099"], confidence: 0.8 }] }])("M2 persists successful reflection watermarks with result %j", async ({ reflections }) => {
    const harness = await createMemoryHarness(memoryStreamReflectionModuleDefinition);
    const call = vi.fn<RunModelPort["call"]>().mockResolvedValue(modelResponse({ reflections }));
    const model = oneAttemptModel(call);
    let host = await startVariantHost(harness, { model });
    try {
      for (const sequence of [1, 2]) insertObservation(harness, { sequence, tick: 10, eventType: "AgreementBreached", summary: "unkept promise" });
      await host.ingestAll(10); await host.runDueMaintenance(11);
      expect(call).toHaveBeenCalledTimes(1);
      expect(host.watermark(memoryAgentId).derivedThroughSeq).toBe(2);
      await host.dispose(); host = await startVariantHost(harness, { model });
      insertObservation(harness, { sequence: 3, tick: 12, eventType: "TickAdvanced", summary: "quiet hour" });
      await host.ingestAll(12); await host.runDueMaintenance(13);
      expect(call).toHaveBeenCalledTimes(1);
      expect(harness.storage.transact((tx) => tx.rows("maintenance_runs").list({ agent_id: memoryAgentId }))).toHaveLength(1);
      const cited = host.retrieve(memoryAgentId, memoryQuery(3, 13)).items[0];
      if (cited === undefined) throw new Error("missing stream record");
      await host.recordUse(memoryAgentId, { baseRevision: 3, turnId: "turn-000000000001", retrievedMemoryIds: [cited.memoryId], citedMemoryIds: [cited.memoryId], noteworthy: [], inputObservations: [], worldTick: 13 });
      const versions = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId, memory_id: cited.memoryId }));
      expect(versions).toHaveLength(2);
      expect(versions).toEqual(expect.arrayContaining([expect.objectContaining({ row_version: 2, recall_count: 1, status: "active" })]));
    } finally { await host.dispose(); await harness.dispose(); }
  });

  it("retries a partial daily review after restart while preserving rule output", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const call = vi.fn<RunModelPort["call"]>()
      .mockRejectedValueOnce(new Error("provider timeout"))
      .mockResolvedValue(modelResponse({ beliefOps: [], currentConcerns: null, intents: [] }));
    const model = oneAttemptModel(call);
    let host = await startVariantHost(harness, { model });
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "unkept promise", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24); await host.runDueMaintenance(24);
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(0);
      const core = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId, tier: "core", status: "active" }));
      expect(core.length).toBeGreaterThan(0);
      await host.dispose(); host = await startVariantHost(harness, { model });
      await host.runDueMaintenance(24);
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[0]?.[0].workRef).not.toBe(call.mock.calls[1]?.[0].workRef);
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(24);
      expect(harness.storage.transact((tx) => tx.rows("maintenance_runs").list({ agent_id: memoryAgentId }))).toEqual([expect.objectContaining({ status: "completed", lease_epoch: 2 })]);
      expect(harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId, tier: "core", status: "active" }))).toEqual(core);
    } finally { await host.dispose(); await harness.dispose(); }
  });

  it("commits belief updates as new versions using the profile output reserve", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const profile = { ...harness.profile, budgets: { ...harness.profile.budgets, reserveOutputTokens: { ...harness.profile.budgets.reserveOutputTokens, "memory-maintenance": 4096 } } };
    const call = vi.fn<RunModelPort["call"]>().mockImplementation(async (work, purpose, reserve, input) => {
      expect(work.agentId).toBe(memoryAgentId); expect(purpose).toBe("memory-maintenance");
      expect(reserve).toBe(4096); expect(input.inputLimit).toBe(4096);
      expect(work.maxModelCalls).toBe(2); expect(work.fence()).toBe(true);
      const text = input.messages.map((message) => message.content).join("\n");
      const evidenceId = /\[(mem-[0-9a-z]+)\]/.exec(text)?.[1];
      if (evidenceId === undefined) throw new Error("missing model evidence");
      const prior = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId, kind: "belief" }).find((row) => row["retired_revision"] === null));
      return modelResponse({ beliefOps: [{ op: prior === undefined ? "add" : "update", beliefId: prior?.["memory_id"] as string ?? null, statement: prior === undefined ? "first belief" : "updated belief", evidenceIds: [evidenceId], confidence: 0.7 }], currentConcerns: null, intents: [] });
    });
    const host = await startVariantHost(harness, { profiles: new Map([[memoryAgentId, profile]]), model: oneAttemptModel(call) });
    try {
      for (const [index, tick] of [24, 48].entries()) {
        insertObservation(harness, { sequence: 2 * index + 1, tick, eventType: "AgreementBreached", summary: "unkept promise", releasePolicyId: index === 0 ? "private:human-independent" : "public", facts: { obligorId: "player-1" } });
        insertObservation(harness, { sequence: 2 * index + 2, tick, eventType: "DayPassed", summary: "day ended" });
        await host.ingestAll(tick); await host.runDueMaintenance(tick);
      }
      expect(call).toHaveBeenCalledTimes(2);
      const beliefs = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId, kind: "belief" }));
      const updated = beliefs.find((row) => row["retired_revision"] === null);
      expect(updated?.["release_policy_id"]).toBe("private:human-independent");
      expect(updated?.["source_observation_ids_json"]).toEqual(["obs-000000000001", "obs-000000000003"]);
      expect(isDisclosable(String(updated?.["release_policy_id"]), { audience: ["player-1"], principalFactions: new Map(), heldEvidenceIds: new Map() })).toBe(false);
      expect(beliefs).toHaveLength(2);
      expect(new Set(beliefs.map((row) => row["memory_id"])).size).toBe(1);
      expect(beliefs).toEqual(expect.arrayContaining([expect.objectContaining({ row_version: 1, retired_revision: 4 }), expect.objectContaining({ row_version: 2, retired_revision: null })]));
    } finally { await host.dispose(); await harness.dispose(); }
  });
});
