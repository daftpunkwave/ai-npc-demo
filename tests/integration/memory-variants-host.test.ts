/**
 * 验证分层混合记忆经真实 MemoryHost 发布模型失败的部分结果。
 * 依赖隔离 SQLite、确定性观察夹具与抛出错误的 scoped 模型端口。
 * 禁止绕过维护队列或直接把失败水位写成成功。
 */
import { describe, expect, it } from "vitest";
import type { RunModelPort } from "@world-prism/module-sdk";
import { MemoryHost } from "@world-prism/agent-runtime";
import { memoryLayeredHybridModuleDefinition } from "@world-prism/mod-agent-memory-ledger";
import {
  createMemoryHarness,
  insertObservation,
  memoryAgentId,
  memoryBranchId,
  memoryIdentity,
  memoryQuery,
  memoryRunId,
  memoryWorldId,
  type MemoryHarness,
} from "./memory-support";

function failedModel(): RunModelPort {
  return {
    route: () => ({
      capabilities: {
        toolCalling: false, strictTools: false, structuredOutput: "json_schema", assistantReplay: "standard",
        contextWindowTokens: 64000, maxOutputTokens: 800, embedding: false, embeddingDimensions: null,
      },
      maxOutputTokens: 800,
    }),
    call: async (work) => { work.beforeAttempt?.(); throw new Error("provider timeout"); },
  };
}

async function close(host: MemoryHost, harness: MemoryHarness): Promise<void> {
  await host.dispose();
  await harness.dispose();
}

describe("MemoryHost layered-hybrid partial maintenance", () => {
  it("stores branch-public chronicle once under the public storage subject", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const host = new MemoryHost({
      storage: harness.storage, host: harness.host, roster: harness.roster,
      profiles: new Map([[memoryAgentId, harness.profile]]), moduleDefinitions: harness.definitions,
      identities: new Map([[memoryAgentId, memoryIdentity]]), worldId: memoryWorldId,
      branchId: memoryBranchId, runId: memoryRunId, signal: new AbortController().signal,
      maintenanceConcurrency: 1,
    });
    await host.start();
    try {
      insertObservation(harness, {
        sequence: 1, tick: 10, eventType: "RelayDown", summary: "中继中断",
        releasePolicyId: "public",
      });
      await host.ingestAll(10);
      const publicRows = harness.storage.transact((tx) =>
        tx.branch(memoryBranchId).table("memory_records").list({ agent_id: "~public" }),
      );
      expect(publicRows).toHaveLength(1);
      expect(host.retrieve(memoryAgentId, memoryQuery(1, 10)).items.some((item) => item.kind === "public")).toBe(true);
    } finally {
      await close(host, harness);
    }
  });

  it("retains rule changes without advancing derived watermarks", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    const host = new MemoryHost({
      storage: harness.storage, host: harness.host, roster: harness.roster,
      profiles: new Map([[memoryAgentId, harness.profile]]), moduleDefinitions: harness.definitions,
      identities: new Map([[memoryAgentId, memoryIdentity]]), worldId: memoryWorldId,
      branchId: memoryBranchId, runId: memoryRunId, signal: new AbortController().signal,
      maintenanceConcurrency: 1, model: failedModel(),
    });
    await host.start();
    try {
      insertObservation(harness, {
        sequence: 1, tick: 24, eventType: "AgreementBreached", summary: "承诺没有兑现",
        facts: { obligorId: "player-1" },
      });
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "第一天结束" });
      await host.ingestAll(24);
      const before = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId }));
      const longRecord = before.find((row) => row["kind"] === "episodic" && row["tier"] === "long");
      expect(longRecord).toBeDefined();
      await host.runDueMaintenance(24);
      const after = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId }));
      expect(after).toEqual(expect.arrayContaining([
        expect.objectContaining({ memory_id: longRecord?.["memory_id"], row_version: 1, retired_revision: 2 }),
        expect.objectContaining({ memory_id: longRecord?.["memory_id"], row_version: 2, created_revision: 2, status: "active", tier: "core" }),
      ]));
      expect(host.watermark(memoryAgentId)).toMatchObject({
        revision: 2,
        derivedThroughTick: 0,
      });
      const task = harness.storage.transact((tx) =>
        tx.rows("maintenance_runs").list({ branch_id: memoryBranchId })[0],
      );
      expect(task).toMatchObject({ status: "failed" });
      expect(task?.["error_json"]).toMatchObject({ status: "partial", failureReason: "provider timeout" });
    } finally {
      await close(host, harness);
    }
  });
});