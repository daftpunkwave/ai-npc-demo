/**
 * 覆盖感知延迟发布、trigger 原子写入与重启时非终态 turn 恢复。
 * 依赖真实 SQLite、假宿主、内容索引与最小感知模块定义；不执行模型或世界命令。
 * 禁止让延迟观察先产生 trigger，或让重启后的旧 turn 继续占用租约。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "@ai-npc/agent-runtime";
import {
  capabilityIdSchema,
  emptyModuleConfigSchema,
  type ModuleDefinition,
  type StoragePort,
  type StorageRow,
} from "@ai-npc/contracts";
import {
  createStatelessModule,
  defineModule,
  type PerceptionPort,
  type PerceptionRequest,
  type SchedulingPort,
} from "@ai-npc/module-sdk";
import { loadContentPack, type ResolvedAgentProfile, type Roster } from "@ai-npc/experiment";
import { memoryNoneModuleDefinition } from "@ai-npc/mod-agent-memory-none";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { createFakeHost, type FakeHost } from "./authority-support";

const resources: { readonly dispose: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.dispose();
});

function perceptionDefinition(requests: PerceptionRequest[]): ModuleDefinition {
  return defineModule({
    id: "agent.perception.test",
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "agent",
    provides: [{
      capability: capabilityIdSchema.parse("agent.perception"),
      cardinality: "exactly-one",
      instanceScope: "agent",
    }],
    requires: [],
    requiresRemote: [],
    configSchema: emptyModuleConfigSchema,
    defaults: {},
    stateSchemaVersion: null,
    migrationPaths: [],
    create: async (input) => {
      const project: PerceptionPort["perceive"] = () => ({
        observations: [{
          observationId: "obs-000000000001",
          scope: {
            worldId: "wld-000000000001",
            branchId: "br-000000000001",
            agentId: "human-independent",
          },
          observationSeq: 0,
          sourceEventIds: ["evt-000000000001"],
          sourceObservationIds: [],
          occurredAtTick: 0,
          sensedAtTick: 2,
          knownAtTick: 2,
          channel: "relay",
          epistemic: "reported",
          confidence: 0.6,
          releasePolicyId: "parties:human-independent,player-1",
          content: { summaryZh: "延迟消息", detail: "full" },
        }],
        triggers: [{
          kind: "message",
          priority: 60,
          sourceRef: "evt-000000000001",
          createdTick: 0,
          dedupeKey: "message:human-independent:evt-000000000001",
        }],
        scannedThroughSeq: 1,
      });
      return createStatelessModule(input, {
        perceive: (request) => {
          requests.push(request);
          return project(request);
        },
      } satisfies PerceptionPort);
    },
  });
}

async function fixture(): Promise<{
  readonly storage: StoragePort;
  readonly host: FakeHost;
  readonly roster: Roster;
  readonly profile: ResolvedAgentProfile;
  readonly definition: ModuleDefinition;
  readonly requests: readonly PerceptionRequest[];
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "agent-runtime-test-"));
  const host = createFakeHost();
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal: new AbortController().signal,
  });
  await instance.start(new AbortController().signal);
  const storage = instance.port as StoragePort;
  storage.transact((tx) => {
    tx.rows("worlds").put({
      world_id: "wld-000000000001",
      pack_id: "earth-2964-v1",
      content_version: "0.2.0",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    tx.rows("branches").put({
      branch_id: "br-000000000001",
      world_id: "wld-000000000001",
      kind: "online",
      status: "active",
      parent_branch_id: null,
      forked_at_world_seq: null,
      run_id: null,
      profile_hash: null,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    tx.branch("br-000000000001").table("clock").put({
      world_tick: 0,
      mode: "running",
      seconds_per_tick: 20,
      run_version: 0,
      step_target_tick: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    tx.branch("br-000000000001").table("agent_activations").put({
      agent_id: "human-independent",
      status: "active",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    tx.branch("br-000000000001").table("controller_leases").put({
      agent_id: "human-independent",
      controller_kind: "agent",
      controller_principal_id: null,
      controller_epoch: 1,
      lease_expires_at: null,
    });
  });
  resources.push({
    dispose: async () => {
      await instance.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
  const roster: Roster = {
    schemaVersion: 1,
    rosterId: "test-roster",
    agents: [{
      agentId: "human-independent",
      kind: "strategic",
      profileRef: "agent-strategic-default",
      toolsetRef: "strategic-default",
    }],
  };
  const profile: ResolvedAgentProfile = {
    profileId: "agent-strategic-default",
    sourceChain: ["test"],
    budgets: {
      maxModelCallsPerTurn: 6,
      maxDecisionRounds: 4,
      maxToolCallsPerTurn: 8,
      maxToolCallsPerRound: 3,
      maxTurnMs: 90000,
      maxReplans: 1,
      maxTokensPerAgentPerDay: 60000,
      reserveOutputTokens: { decision: 1500, speech: 400, "memory-maintenance": 800 },
    },
    readiness: { requireDurable: true, requireDerived: true, waitTimeoutMs: 120000, onlineDegradeAfterMs: 10000 },
    speech: { maxChars: 80 },
    failurePolicy: "strict",
    scheduling: { module: "agent.scheduling.fair", config: {} },
    slots: {
      perception: { module: "agent.perception.test", config: {} },
      memory: { module: "agent.memory.none", config: {} },
      context: { module: "agent.context.ordered-blocks", config: {} },
      compression: { module: "agent.compression.none", config: {} },
      toolView: { module: "agent.tool-view.structured", config: {} },
      decision: { module: "agent.decision.deterministic", config: {} },
    },
  };
  const requests: PerceptionRequest[] = [];
  return { storage, host, roster, profile, definition: perceptionDefinition(requests), requests };
}

describe("Agent runtime 持久状态", () => {
  it("延迟观察与 trigger 在到期 tick 同时发布。非受众事件只推进扫描水位", async () => {
    const value = await fixture();
    const scheduling: SchedulingPort = { plan: () => [] };
    const runtime = new AgentRuntime({
      storage: value.storage,
      host: value.host,
      content: loadContentPack("content", "earth-2964-v1"),
      roster: value.roster,
      profiles: new Map([["human-independent", value.profile]]),
      moduleDefinitions: new Map([
        [value.definition.id, value.definition],
        [memoryNoneModuleDefinition.id, memoryNoneModuleDefinition],
      ]),
      scheduling,
      maxConcurrentTurns: 1,
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      runId: "run-000000000001",
      readWorld: () => ({
        nodeId: "grayharbor",
        factionId: "human-independent",
        worldViewText: "",
        affairsText: "",
      }),
    });
    await runtime.start();
    resources.push({ dispose: () => runtime.dispose() });
    value.storage.transact((tx) => {
      const events = tx.branch("br-000000000001").table("domain_events");
      const message = {
        world_seq: 1,
        event_id: "evt-000000000001",
        world_tick: 0,
        type: "MessageSent",
        schema_version: 1,
        principal_id: "player-1",
        causation_ids_json: [],
        correlation_id: "corr-000000000001",
        audience_json: [{ kind: "principals", ids: ["player-1", "human-independent"] }],
        payload_json: {
          messageId: "msg-000000000001",
          fromId: "player-1",
          to: ["human-independent"],
          channel: "message",
          text: "延迟消息",
          deliveries: [{ principalId: "human-independent", deliverAtTick: 2 }],
          intentKind: "inform",
          speechArtifactRef: null,
        },
        committed_at: "2026-01-01T00:00:00.000Z",
      };
      events.put(message);
      events.put({
        ...message,
        world_seq: 2,
        event_id: "evt-000000000002",
        audience_json: [{ kind: "principals", ids: ["player-1", "human-earth-alliance"] }],
        payload_json: {
          ...message.payload_json,
          messageId: "msg-000000000002",
          to: ["human-earth-alliance"],
          deliveries: [{ principalId: "human-earth-alliance", deliverAtTick: 2 }],
        },
      });
    });
    await runtime.pump();
    expect(value.storage.transact((tx) =>
      tx.branch("br-000000000001").table("perception_state").get({ agent_id: "human-independent" }),
    )).toMatchObject({ scanned_through_seq: 2 });
    expect(value.storage.transact((tx) => tx.branch("br-000000000001").table("triggers").list())).toHaveLength(0);
    expect(value.storage.transact((tx) => tx.branch("br-000000000001").table("observations").list())).toHaveLength(0);
    value.storage.transact((tx) => {
      const table = tx.branch("br-000000000001").table("clock");
      const row = table.get({});
      table.put({ ...row, world_tick: 2 });
    });
    await runtime.pump();
    expect(value.storage.transact((tx) => tx.branch("br-000000000001").table("observations").list())).toHaveLength(1);
    expect(value.storage.transact((tx) => tx.branch("br-000000000001").table("triggers").list())).toHaveLength(1);
    expect(value.storage.transact((tx) =>
      tx.branch("br-000000000001").table("memory_watermarks").get({ agent_id: "human-independent" }),
    )).toMatchObject({
      revision: 1,
      observation_seq_consumed: 1,
      derived_through_seq: 1,
    });
    expect(value.storage.transact((tx) =>
      tx.branch("br-000000000001").table("memory_records").count({ agent_id: "human-independent" }),
    )).toBe(0);
    value.storage.transact((tx) => {
      const events = tx.branch("br-000000000001").table("domain_events");
      const stockpile: StorageRow = {
        world_seq: 3, event_id: "evt-000000000003", world_tick: 2, schema_version: 1, type: "StockpileAdjusted",
        principal_id: "human-earth-alliance", causation_ids_json: [], correlation_id: "corr-000000000003",
        payload_json: { stockpileId: "sp-alliance", delta: { supply: 10 }, reason: "private adjustment" },
        audience_json: [{ kind: "faction", factionId: "human-earth-alliance" }, { kind: "node", nodeId: "grayharbor" }],
        committed_at: "2026-01-01T00:00:00.000Z",
      };
      events.put(stockpile);
      events.put({
        ...stockpile, world_seq: 4, event_id: "evt-000000000004",
        audience_json: [{ kind: "faction", factionId: "human-earth-alliance" }, { kind: "node", nodeId: "watergate" }],
      });
    });
    await runtime.pump();
    expect(value.requests.map(({ event }) => event.eventId)).toEqual(["evt-000000000001", "evt-000000000003"]);
    const local = value.requests[1];
    expect(local?.event.payload).toEqual({ nodeId: "grayharbor" });
    expect(local?.rendered).toMatchObject({ full: { refs: {}, facts: {} }, releasePolicyId: "public" });
    expect(local?.rendered.full.summaryZh).not.toContain("private adjustment");
  });

  it("启动时取消遗留非终态 turn 并释放 trigger", async () => {
    const value = await fixture();
    value.storage.transact((tx) => {
      tx.rows("turn_runs").put({
        turn_id: "turn-000000000001",
        run_id: "test-run",
        branch_id: "br-000000000001",
        agent_id: "human-independent",
        agent_turn_index: 1,
        status: "deciding",
        trigger_ids_json: ["trg-000000000001"],
        input_frontier_json: null,
        memory_revision: null,
        profile_hash: "profile",
        controller_epoch: 1,
        turn_lease_epoch: 1,
        lease_expires_at: "2025-01-01T00:00:00.000Z",
        terminal_reason: null,
        effective_json: [],
        created_at: "2026-01-01T00:00:00.000Z",
        created_tick: 0,
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: null,
      });
      tx.branch("br-000000000001").table("triggers").put({
        trigger_id: "trg-000000000001",
        agent_id: "human-independent",
        kind: "message",
        priority: 60,
        source_ref: "evt-000000000001",
        created_tick: 0,
        dedupe_key: "message:human-independent:evt-000000000001",
        consumed_by_turn_id: "turn-000000000001",
      });
    });
    const runtime = new AgentRuntime({
      storage: value.storage,
      host: value.host,
      content: loadContentPack("content", "earth-2964-v1"),
      roster: value.roster,
      profiles: new Map([["human-independent", value.profile]]),
      moduleDefinitions: new Map([
        [value.definition.id, value.definition],
        [memoryNoneModuleDefinition.id, memoryNoneModuleDefinition],
      ]),
      scheduling: { plan: () => [] },
      maxConcurrentTurns: 1,
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      runId: "run-000000000001",
      readWorld: () => ({ nodeId: "grayharbor", factionId: "human-independent", worldViewText: "", affairsText: "" }),
    });
    await runtime.start();
    resources.push({ dispose: () => runtime.dispose() });
    expect(value.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: "turn-000000000001" }))).toMatchObject({
      status: "cancelled",
      terminal_reason: "runtime-restarted",
    });
    expect(value.storage.transact((tx) => tx.branch("br-000000000001").table("triggers").get({ trigger_id: "trg-000000000001" }))).toMatchObject({
      consumed_by_turn_id: null,
    });
  });

  it("未配置记忆槽位时保持既有运行时启动路径", async () => {
    const value = await fixture();
    const profile: ResolvedAgentProfile = {
      ...value.profile,
      slots: {
        ...value.profile.slots,
        memory: undefined as never,
      },
    };
    const runtime = new AgentRuntime({
      storage: value.storage,
      host: value.host,
      content: loadContentPack("content", "earth-2964-v1"),
      roster: value.roster,
      profiles: new Map([["human-independent", profile]]),
      moduleDefinitions: new Map([[value.definition.id, value.definition]]),
      scheduling: { plan: () => [] },
      maxConcurrentTurns: 1,
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      runId: "run-000000000001",
      readWorld: () => ({
        nodeId: "grayharbor",
        factionId: "human-independent",
        worldViewText: "",
        affairsText: "",
      }),
    });
    await runtime.start();
    resources.push({ dispose: () => runtime.dispose() });
    await runtime.pump();
    expect(value.storage.transact((tx) =>
      tx.branch("br-000000000001").table("memory_watermarks").list(),
    )).toHaveLength(0);
  });

  it("CampaignStarted 重放不再因历史配额超限中断感知消费", async () => {
    const value = await fixture();
    value.storage.transact((tx) => {
      const activations = tx.branch("br-000000000001").table("agent_activations");
      for (let index = 0; index < 15; index += 1) {
        activations.put({
          agent_id: `agent-extra-${index}`,
          status: "active",
          updated_at: "2026-01-01T00:00:00.000Z",
        });
      }
      tx.branch("br-000000000001").table("domain_events").put({
        world_seq: 1,
        event_id: "evt-000000000002",
        world_tick: 0,
        type: "CampaignStarted",
        schema_version: 1,
        principal_id: "player-1",
        causation_ids_json: [],
        correlation_id: "corr-000000000002",
        audience_json: [{ kind: "public" }],
        payload_json: {
          campaignId: "cmp-000000000001",
          factionId: "human-neutral",
          playerId: "player-1",
        },
        committed_at: "2026-01-01T00:00:00.000Z",
      });
    });
    const runtime = new AgentRuntime({
      storage: value.storage,
      host: value.host,
      content: loadContentPack("content", "earth-2964-v1"),
      roster: value.roster,
      profiles: new Map([["human-independent", value.profile]]),
      moduleDefinitions: new Map([
        [value.definition.id, value.definition],
        [memoryNoneModuleDefinition.id, memoryNoneModuleDefinition],
      ]),
      scheduling: { plan: () => [] },
      maxConcurrentTurns: 1,
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      runId: "run-000000000001",
      readWorld: () => ({
        nodeId: "grayharbor",
        factionId: "human-independent",
        worldViewText: "",
        affairsText: "",
      }),
    });
    await expect(runtime.start()).resolves.toBeUndefined();
    resources.push({ dispose: () => runtime.dispose() });
    // 感知消费只推进游标，不补做名册激活，因此既有激活行保持不变。
    expect(value.storage.transact((tx) =>
      tx.branch("br-000000000001").table("agent_activations").count({ status: "active" }),
    )).toBe(16);
    expect(value.storage.transact((tx) =>
      tx.branch("br-000000000001").table("consumer_offsets").get({ consumer_id: "agent.perception.local" }),
    )).toMatchObject({ last_world_seq: 1 });
  });
});
