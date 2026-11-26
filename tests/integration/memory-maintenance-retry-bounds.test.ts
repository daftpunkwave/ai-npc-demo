/**
 * 核心职责：验证记忆维护任务在反复失败与持续未就绪时的终止边界。
 * 交互契约：使用真实 SQLite 与 MemoryHost，只通过宿主公开方法观察队列行。
 * 约束与禁忌：禁止伪造水位、租约或健康摘要，也不允许直接改队列行来制造预期结果。
 */
import { describe, expect, it, vi } from "vitest";
import type { RunModelPort } from "@ai-npc/module-sdk";
import { memoryLayeredHybridModuleDefinition } from "@ai-npc/mod-agent-memory-ledger";
import { createMemoryHarness, insertObservation, memoryAgentId, memoryBranchId } from "./memory-support";
import { modelResponse, oneAttemptModel, startVariantHost } from "./memory-variants-support";

const emptyReview = { beliefOps: [], currentConcerns: null, intents: [] };

/** 只读队列行；不断言业务内容，仅看状态、失败次数与重排时间点。 */
function maintenanceRows(harness: Awaited<ReturnType<typeof createMemoryHarness>>) {
  return harness.storage.transact((tx) =>
    tx.rows("maintenance_runs").list({ branch_id: memoryBranchId, agent_id: memoryAgentId }));
}

describe("maintenance retry bounds", () => {
  it("停止认领已达尝试上限的任务，并在健康摘要中报告", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const profile = {
      ...harness.profile,
      slots: {
        ...harness.profile.slots,
        memory: {
          module: memoryLayeredHybridModuleDefinition.id,
          config: { llmMaintenance: { enabled: true, maxAgentsPerDay: 1 } },
        },
      },
    };
    const call = vi.fn<RunModelPort["call"]>().mockRejectedValue(new Error("provider unavailable"));
    const host = await startVariantHost(harness, {
      profiles: new Map([[memoryAgentId, profile]]),
      model: oneAttemptModel(call),
    });
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "breach", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24);
      // 每日名额限制为一次，因此逐日推进才可能重复认领；上限为三次，之后不得再认领。
      for (const tick of [24, 48, 72, 96, 120, 144]) await host.runDueMaintenance(tick);
      expect(call).toHaveBeenCalledTimes(3);
      const rows = maintenanceRows(harness);
      expect(rows.every((row) => row["status"] === "failed")).toBe(true);
      expect(host.exhaustedMaintenance()).toBe(rows.length);
      // 失败任务不被重新认领：租约代次停在最后一次认领，不再增长。
      const epochs = rows.map((row) => Number(row["lease_epoch"]));
      await host.runDueMaintenance(168);
      expect(maintenanceRows(harness).map((row) => Number(row["lease_epoch"]))).toEqual(epochs);
      expect(call).toHaveBeenCalledTimes(3);
    } finally {
      await host.dispose();
      await harness.dispose();
    }
  });

  it("水位未追平时按逻辑时间退避重排，而不是每轮立刻重新认领", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const profile = {
      ...harness.profile,
      // readiness 要求持久与派生水位；把派生水位卡住即可让任务持续 not-ready。
      readiness: { requireDurable: true, requireDerived: true, waitTimeoutMs: 120000, onlineDegradeAfterMs: 10000 },
      slots: {
        ...harness.profile.slots,
        memory: {
          module: memoryLayeredHybridModuleDefinition.id,
          config: { llmMaintenance: { enabled: true, maxAgentsPerDay: 1 } },
        },
      },
    };
    const call = vi.fn<RunModelPort["call"]>().mockResolvedValue(modelResponse(emptyReview));
    const host = await startVariantHost(harness, {
      profiles: new Map([[memoryAgentId, profile]]),
      model: oneAttemptModel(call),
    });
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "breach", facts: { obligorId: "player-1" } });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await host.ingestAll(24);
      // 让水位落后于任务覆盖范围，触发 defer 分支。
      harness.storage.transact((tx) => {
        const table = tx.branch(memoryBranchId).table("memory_watermarks");
        const row = table.get({ agent_id: memoryAgentId });
        if (row === null) throw new Error("Missing memory watermark");
        table.put({ ...row, observation_seq_consumed: 0, derived_through_seq: 0 });
      });
      await host.runDueMaintenance(24);
      const deferred = maintenanceRows(harness);
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toMatchObject({ status: "queued", lease_expires_at: null });
      const task = deferred[0]?.["task_json"] as { readonly retryAfterTick?: number; readonly failureAttempts?: number };
      // 首次延期把任务重排到下一个逻辑 tick；延期不计入失败次数。
      expect(task.retryAfterTick).toBe(25);
      expect(task.failureAttempts).toBe(0);
      expect(call).not.toHaveBeenCalled();
      // 重排未到期时同一 tick 内不再重新认领。
      await host.runDueMaintenance(24);
      expect(call).not.toHaveBeenCalled();
      expect(maintenanceRows(harness)[0]).toMatchObject({ lease_expires_at: null });
    } finally {
      await host.dispose();
      await harness.dispose();
    }
  });
});
