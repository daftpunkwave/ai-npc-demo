/**
 * 核心职责：验证每日模型名额、迟到任务、失败重试与取消边界。
 * 交互契约：真实宿主和 SQLite 管理任务状态，模型只记录被允许的实际调用。
 * 约束与禁忌：禁止直接伪造租约、水位或模型配额决策。
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentObservation } from "@world-prism/contracts";
import type { RunModelPort } from "@world-prism/module-sdk";
import { memoryLayeredHybridModuleDefinition } from "@world-prism/mod-agent-memory-ledger";
import { createMemoryHarness, insertObservation, memoryAgentId, memoryBranchId, memoryIdentity } from "./memory-support";
import { memoryModelRoute, modelResponse, oneAttemptModel, startVariantHost } from "./memory-variants-support";

const emptyReview = { beliefOps: [], currentConcerns: null, intents: [] };

describe("maintenance model quota and cancellation", () => {
  it("releases an unsent attempt's persistent quota for a same-day retry", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const profile = { ...harness.profile, slots: { ...harness.profile.slots, memory: { module: memoryLayeredHybridModuleDefinition.id, config: { llmMaintenance: { enabled: true, maxAgentsPerDay: 1 } } } } };
    const call = vi.fn<RunModelPort["call"]>()
      .mockImplementationOnce(async (work) => { const release = work.beforeAttempt?.(); release?.(); throw new Error("request was not sent"); })
      .mockImplementation(async (work) => { work.beforeAttempt?.(); return modelResponse(emptyReview); });
    const host = await startVariantHost(harness, { profiles: new Map([[memoryAgentId, profile]]), model: { route: () => memoryModelRoute, call } });
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "breach", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24); await host.runDueMaintenance(24);
      const task = harness.storage.transact((tx) => tx.rows("maintenance_runs").list({ agent_id: memoryAgentId })[0]);
      expect(task?.["task_json"]).toMatchObject({ modelCallDays: [] });
      await host.runDueMaintenance(24);
      expect(call).toHaveBeenCalledTimes(2);
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(24);
    } finally { await host.dispose(); await harness.dispose(); }
  });
  it.each([1, 2])("persists quota %i for concurrent, completed and late tasks", async (quota) => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const profile = { ...harness.profile, slots: { ...harness.profile.slots, memory: { module: memoryLayeredHybridModuleDefinition.id, config: { llmMaintenance: { enabled: true, maxAgentsPerDay: quota } } } } };
    const agents = [memoryAgentId, "human-pacifist"];
    const call = vi.fn<RunModelPort["call"]>().mockResolvedValue(modelResponse(emptyReview));
    harness.storage.transact((tx) => tx.branch(memoryBranchId).table("agent_activations").put({ agent_id: agents[1] ?? "", status: "active", updated_at: harness.host.nowIso() }));
    const host = await startVariantHost(harness, {
      roster: { ...harness.roster, agents: agents.map((agentId) => ({ agentId, kind: "strategic", profileRef: "memory-test-profile", toolsetRef: "memory-test-tools" })) },
      profiles: new Map(agents.map((id) => [id, profile])), identities: new Map(agents.map((id) => [id, memoryIdentity])), maintenanceConcurrency: 2,
      model: oneAttemptModel(call),
    });
    try {
      for (const [agentIndex, agentId] of agents.entries()) {
        for (const sequence of [1, 2]) insertObservation(harness, {
          sequence, agentId, observationId: `obs-${String(agentIndex * 10 + sequence).padStart(12, "0")}` as AgentObservation["observationId"],
          tick: 24, eventType: sequence === 1 ? "AgreementBreached" : "DayPassed", summary: "daily event", facts: { obligorId: "player-1" },
        });
      }
      await host.ingestAll(24); await host.runDueMaintenance(24);
      expect(call).toHaveBeenCalledTimes(quota);
      expect(new Set(call.mock.calls.map(([work]) => work.workRef)).size).toBe(quota);
      for (const agent of agents) expect(host.watermark(agent).derivedThroughTick).toBe(24);
      /** 同一游戏日迟到的每日观察不能重新打开已用尽的配额。 */
      insertObservation(harness, { sequence: 3, tick: 25, eventType: "AgreementBreached", summary: "late breach", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 4, tick: 25, eventType: "DayPassed", summary: "late day notification" });
      await host.ingestAll(25); await host.runDueMaintenance(25);
      expect(call).toHaveBeenCalledTimes(quota);
      const tasks = harness.storage.transact((tx) => tx.rows("maintenance_runs").list({ branch_id: memoryBranchId }));
      expect(tasks.filter((row) => (row["task_json"] as { modelQuotaGranted?: boolean }).modelQuotaGranted)).toHaveLength(quota);
    } finally { await host.dispose(); await harness.dispose(); }
  });

  it("counts failed model attempts and permits a later-day retry after restart", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const profile = { ...harness.profile, slots: { ...harness.profile.slots, memory: { module: memoryLayeredHybridModuleDefinition.id, config: { llmMaintenance: { enabled: true, maxAgentsPerDay: 1 } } } } };
    const call = vi.fn<RunModelPort["call"]>().mockRejectedValueOnce(new Error("provider timeout")).mockResolvedValue(modelResponse(emptyReview));
    const options = { profiles: new Map([[memoryAgentId, profile]]), model: oneAttemptModel(call) };
    let host = await startVariantHost(harness, options);
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "breach", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24); await host.runDueMaintenance(24);
      await host.dispose(); host = await startVariantHost(harness, options);
      await host.runDueMaintenance(24);
      await host.runDueMaintenance(24);
      await host.runDueMaintenance(24);
      expect(harness.storage.transact((tx) => tx.rows("maintenance_runs").list({ agent_id: memoryAgentId }))[0]).toMatchObject({ lease_epoch: 1 });
      expect(call).toHaveBeenCalledTimes(1);
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(0);
      await host.runDueMaintenance(48);
      expect(call).toHaveBeenCalledTimes(2);
      expect(call.mock.calls[1]?.[0].worldTick).toBe(48);
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(24);
    } finally { await host.dispose(); await harness.dispose(); }
  });

  it("does not invoke the model after cancellation", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const signal = new AbortController();
    const call = vi.fn<RunModelPort["call"]>().mockResolvedValue(modelResponse(emptyReview));
    const host = await startVariantHost(harness, { signal: signal.signal, model: oneAttemptModel(call) });
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "breach", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24); signal.abort(); await host.runDueMaintenance(24);
      expect(call).not.toHaveBeenCalled();
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(0);
    } finally { await host.dispose(); await harness.dispose(); }
  });
});
