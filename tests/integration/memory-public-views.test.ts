/**
 * 核心职责：验证并发公共编年史去重、冻结版本隔离与跨 Agent 公开来源整理。
 * 交互契约：使用两个真实记忆宿主及同一隔离 SQLite，只读取存储结果。
 * 约束与禁忌：禁止直接写入公共记忆或绕过记忆提交路径。
 */
import { describe, expect, it } from "vitest";
import { estimateTokens, type AgentObservation } from "@world-prism/contracts";
import type { RunModelPort } from "@world-prism/module-sdk";
import { memoryLayeredHybridModuleDefinition, memoryLedgerModuleDefinition, memoryStreamReflectionModuleDefinition } from "@world-prism/mod-agent-memory-ledger";
import { createMemoryHarness, insertObservation, memoryAgentId, memoryBranchId, memoryIdentity, memoryQuery } from "./memory-support";
import { modelResponse, startVariantHost } from "./memory-variants-support";

const otherAgent = "human-pacifist";

describe("public memory revision boundaries", () => {
  it.each([memoryLedgerModuleDefinition, memoryStreamReflectionModuleDefinition])("keeps $id isolated from another provider's public history", async (definition) => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    harness.storage.transact((tx) => tx.branch(memoryBranchId).table("agent_activations").put({ agent_id: otherAgent, status: "active", updated_at: harness.host.nowIso() }));
    const publisher = await startVariantHost(harness);
    let reader: Awaited<ReturnType<typeof startVariantHost>> | undefined;
    try {
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "RelayDown", summary: "publisher public history", releasePolicyId: "public" });
      await publisher.ingestAll(24);
      reader = await startVariantHost(harness, {
        roster: { ...harness.roster, agents: [{ agentId: otherAgent, kind: "strategic", profileRef: "memory-test-profile", toolsetRef: "memory-test-tools" }] },
        profiles: new Map([[otherAgent, { ...harness.profile, slots: { ...harness.profile.slots, memory: { module: definition.id, config: {} } } }]]),
        identities: new Map([[otherAgent, memoryIdentity]]), moduleDefinitions: new Map([[definition.id, definition]]),
      });
      insertObservation(harness, { sequence: 1, agentId: otherAgent, observationId: "obs-000000000011", tick: 24, eventType: "DayPassed", summary: "reader day ended" });
      await reader.ingestAll(24); await reader.runDueMaintenance(24);
      const revision = reader.watermark(otherAgent).revision;
      const bundle = reader.retrieve(otherAgent, { ...memoryQuery(revision, 24), scope: { ...memoryQuery(revision, 24).scope, agentId: otherAgent } });
      expect(bundle.items.some((item) => item.kind === "public")).toBe(false);
      expect(harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: "~public" }))).toHaveLength(1);
      if (definition.id === memoryLedgerModuleDefinition.id) expect(reader.watermark(otherAgent).derivedThroughTick).toBe(24);
    } finally { await reader?.dispose(); await publisher.dispose(); await harness.dispose(); }
  });
  it("deduplicates concurrent and repeated observations and keeps old views immutable", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    harness.storage.transact((tx) => tx.branch(memoryBranchId).table("agent_activations").put({ agent_id: otherAgent, status: "active", updated_at: harness.host.nowIso() }));
    const first = await startVariantHost(harness);
    const second = await startVariantHost(harness, {
      roster: { ...harness.roster, agents: [{ agentId: otherAgent, kind: "strategic", profileRef: "memory-test-profile", toolsetRef: "memory-test-tools" }] },
      profiles: new Map([[otherAgent, harness.profile]]), identities: new Map([[otherAgent, memoryIdentity]]),
    });
    const rows = () => harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: "~public" }));
    const sharedEvent = ["evt-000000000001"] as AgentObservation["sourceEventIds"];
    try {
      insertObservation(harness, { sequence: 1, tick: 10, eventType: "RelayDown", summary: "relay outage", releasePolicyId: "public", sourceEventIds: sharedEvent });
      for (const sequence of [1, 2]) insertObservation(harness, {
        sequence, agentId: otherAgent, observationId: `obs-${String(10 + sequence).padStart(12, "0")}` as AgentObservation["observationId"],
        tick: 10, eventType: "RelayDown", summary: "relay outage", releasePolicyId: "public", sourceEventIds: sharedEvent,
      });
      await Promise.all([first.ingestAll(10), second.ingestAll(10)]);
      expect(rows()).toHaveLength(1);
      const frozen = first.retrieve(memoryAgentId, memoryQuery(1, 100)).items;
      insertObservation(harness, { sequence: 3, agentId: otherAgent, observationId: "obs-000000000013", tick: 24, eventType: "RelayDown", summary: "later outage", releasePolicyId: "public" });
      await second.ingestAll(24);
      expect(rows()).toHaveLength(2);
      expect(first.retrieve(memoryAgentId, memoryQuery(1, 100)).items).toEqual(frozen);
      expect(first.retrieve(memoryAgentId, memoryQuery(1, 100)).items.some((item) => item.summaryZh === "later outage")).toBe(false);
      insertObservation(harness, { sequence: 2, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await first.ingestAll(24);
      const refreshed = first.retrieve(memoryAgentId, { ...memoryQuery(2, 24), maxItems: 30, maxTokens: 10000 });
      expect(refreshed.items.some((item) => item.kind === "public" && item.summaryZh === "later outage")).toBe(true);
      const zero = first.retrieve(memoryAgentId, { ...memoryQuery(2, 24), maxItems: 0, maxTokens: 0 });
      expect(zero.items).toEqual([]);
      const limited = first.retrieve(memoryAgentId, { ...memoryQuery(2, 24), maxTokens: 8 });
      // maxTokens 以 estimate-v1 的 token 口径计量，断言必须用同一口径求和。
      expect(limited.items.reduce((sum, item) => sum + estimateTokens(item.summaryZh), 0)).toBeLessThanOrEqual(8);
      await first.runDueMaintenance(24);
      expect(first.watermark(memoryAgentId).revision).toBe(3);
      expect(first.retrieve(memoryAgentId, memoryQuery(1, 100)).items).toEqual(frozen);
    } finally {
      await second.dispose(); await first.dispose(); await harness.dispose();
    }
  });

  it("accepts model beliefs sourced from another Agent's frozen public record", async () => {
    const harness = await createMemoryHarness(memoryLayeredHybridModuleDefinition);
    harness.storage.transact((tx) => tx.branch(memoryBranchId).table("agent_activations").put({ agent_id: otherAgent, status: "active", updated_at: harness.host.nowIso() }));
    const publisher = await startVariantHost(harness, {
      roster: { ...harness.roster, agents: [{ agentId: otherAgent, kind: "strategic", profileRef: "memory-test-profile", toolsetRef: "memory-test-tools" }] },
      profiles: new Map([[otherAgent, harness.profile]]), identities: new Map([[otherAgent, memoryIdentity]]),
    });
    let evidenceId = "";
    const model: RunModelPort = {
      route: () => ({ capabilities: { toolCalling: false, strictTools: false, structuredOutput: "json_schema", assistantReplay: "standard", contextWindowTokens: 64000, maxOutputTokens: 800, embedding: false, embeddingDimensions: null }, maxOutputTokens: 800 }),
      call: async (work) => { work.beforeAttempt?.(); return modelResponse({ beliefOps: [{ op: "add", beliefId: null, statement: "relay needs attention", evidenceIds: [evidenceId], confidence: 0.8 }], currentConcerns: null, intents: [] }); },
    };
    const reader = await startVariantHost(harness, { model });
    try {
      insertObservation(harness, { sequence: 1, agentId: otherAgent, observationId: "obs-000000000011", tick: 24, eventType: "RelayDown", summary: "public relay outage", releasePolicyId: "public" });
      await publisher.ingestAll(24);
      const publicRow = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: "~public" })[0]);
      evidenceId = String(publicRow?.["memory_id"]);
      insertObservation(harness, { sequence: 1, tick: 24, eventType: "DayPassed", summary: "day ended" });
      await reader.ingestAll(24);
      await reader.runDueMaintenance(24);
      const tasks = harness.storage.transact((tx) => tx.rows("maintenance_runs").list({ agent_id: memoryAgentId }));
      expect(tasks[0]).toMatchObject({ status: "completed" });
      const beliefs = harness.storage.transact((tx) => tx.branch(memoryBranchId).table("memory_records").list({ agent_id: memoryAgentId, kind: "belief" }));
      expect(beliefs).toHaveLength(1);
      expect(beliefs[0]?.["source_observation_ids_json"]).toEqual(["obs-000000000011"]);
    } finally {
      await reader.dispose(); await publisher.dispose(); await harness.dispose();
    }
  });
});
