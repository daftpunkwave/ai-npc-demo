/**
 * 为记忆宿主测试提供隔离 SQLite、名册、profile 与观察夹具。
 * 依赖真实存储适配器与确定性宿主服务。
 * 禁止直接写入记忆记录，或绕过宿主发布路径。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentObservation,
  AgentMemoryQuery,
  Json,
  ModuleDefinition,
  StoragePort,
} from "@world-prism/contracts";
import type {
  MemoryAgentIdentity,
  MemoryRecordView,
  RevisionView,
} from "@world-prism/module-sdk";
import type { ResolvedAgentProfile, Roster } from "@world-prism/contracts";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { createFakeHost, type FakeHost } from "./authority-support";

export const memoryWorldId = "wld-000000000001";
export const memoryBranchId = "br-000000000001";
export const memoryRunId = "run-000000000001";
export const memoryAgentId = "human-independent";

export const memoryIdentity: MemoryAgentIdentity = {
  factionId: "human-independent",
  values: ["重约", "怕封锁"],
  initialRelations: [{ targetId: "player-1", trust: 0 }],
  personalityKeywords: {
    agreement: ["约"],
    rescue: ["救"],
    resource: ["供给"],
    road: ["封锁"],
    evidence: ["证据"],
  },
};

export const memoryRoster: Roster = {
  schemaVersion: 1,
  rosterId: "memory-test",
  agents: [{
    agentId: memoryAgentId,
    kind: "strategic",
    profileRef: "memory-test-profile",
    toolsetRef: "memory-test-tools",
  }],
};

export function memoryProfile(moduleId: string): ResolvedAgentProfile {
  return {
    profileId: "memory-test-profile",
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
      perception: { module: "agent.perception.local", config: {} },
      memory: { module: moduleId, config: {} },
      context: { module: "agent.context.ordered-blocks", config: {} },
      compression: { module: "agent.compression.none", config: {} },
      toolView: { module: "agent.tool-view.structured", config: {} },
      decision: { module: "agent.decision.deterministic", config: {} },
    },
  };
}

export interface MemoryHarness {
  readonly storage: StoragePort;
  readonly host: FakeHost;
  readonly roster: Roster;
  readonly profile: ResolvedAgentProfile;
  readonly definitions: ReadonlyMap<string, ModuleDefinition>;
  dispose(): Promise<void>;
}

export async function createMemoryHarness(
  definition: ModuleDefinition,
): Promise<MemoryHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
  const host = createFakeHost();
  const signal = new AbortController().signal;
  const instance = await storageModuleDefinition.create({
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal,
  });
  try {
    await instance.start(signal);
    const storage = instance.port as StoragePort;
    storage.transact((tx) => {
      tx.rows("worlds").put({
        world_id: memoryWorldId,
        pack_id: "earth-2964-v1",
        content_version: "0.3.0",
        created_at: host.nowIso(),
      });
      tx.rows("branches").put({
        branch_id: memoryBranchId,
        world_id: memoryWorldId,
        kind: "online",
        status: "active",
        parent_branch_id: null,
        forked_at_world_seq: null,
        run_id: null,
        profile_hash: null,
        created_at: host.nowIso(),
      });
      const branch = tx.branch(memoryBranchId);
      branch.table("clock").put({
        world_tick: 0,
        mode: "running",
        seconds_per_tick: 1,
        run_version: 0,
        step_target_tick: null,
        updated_at: host.nowIso(),
      });
      branch.table("agent_activations").put({
        agent_id: memoryAgentId,
        status: "active",
        updated_at: host.nowIso(),
      });
      branch.table("controller_leases").put({
        agent_id: memoryAgentId,
        controller_kind: "agent",
        controller_principal_id: null,
        controller_epoch: 1,
        lease_expires_at: null,
      });
      branch.table("perception_state").put({
        agent_id: memoryAgentId,
        module_id: "agent.perception.local",
        revision: 1,
        scanned_through_seq: 100,
        state_json: {},
      });
    });
    return {
      storage,
      host,
      roster: memoryRoster,
      profile: memoryProfile(definition.id),
      definitions: new Map([[definition.id, definition]]),
      dispose: async () => {
        await instance.dispose();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await instance.dispose();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

export function insertObservation(
  harness: MemoryHarness,
  input: {
    readonly sequence: number;
    readonly agentId?: string;
    readonly observationId?: AgentObservation["observationId"];
    readonly sourceEventIds?: AgentObservation["sourceEventIds"];
    readonly tick: number;
    readonly eventType: string;
    readonly summary: string;
    readonly facts?: Json;
    readonly channel?: string;
    readonly subjectIds?: readonly string[];
    readonly releasePolicyId?: string;
  },
): AgentObservation {
  const observation: AgentObservation = {
    observationId: input.observationId ?? `obs-${String(input.sequence).padStart(12, "0")}` as AgentObservation["observationId"],
    scope: {
      worldId: memoryWorldId,
      branchId: memoryBranchId,
      agentId: input.agentId ?? memoryAgentId,
    },
    observationSeq: input.sequence,
    sourceEventIds: input.sourceEventIds ?? [`evt-${String(input.sequence).padStart(12, "0")}` as AgentObservation["sourceEventIds"][number]],
    sourceObservationIds: [],
    occurredAtTick: input.tick,
    sensedAtTick: input.tick,
    knownAtTick: input.tick,
    channel: input.channel ?? "party",
    epistemic: "witnessed",
    confidence: 1,
    releasePolicyId: input.releasePolicyId ?? "parties:human-independent,player-1",
    content: {
      eventType: input.eventType,
      summaryZh: input.summary,
      subjectIds: [...(input.subjectIds ?? ["player-1"])],
      nodeId: null,
      refs: {},
      facts: input.facts ?? {},
      claim: null,
      detail: "full",
    },
  };
  harness.storage.transact((tx) => {
    tx.branch(memoryBranchId).table("observations").put({
      agent_id: observation.scope.agentId,
      observation_seq: observation.observationSeq,
      observation_id: observation.observationId,
      source_event_ids_json: [...observation.sourceEventIds],
      source_observation_ids_json: [],
      occurred_at_tick: observation.occurredAtTick,
      sensed_at_tick: observation.sensedAtTick,
      known_at_tick: observation.knownAtTick,
      channel: observation.channel,
      epistemic: observation.epistemic,
      confidence: observation.confidence,
      release_policy_id: observation.releasePolicyId,
      content_json: observation.content,
    });
  });
  return observation;
}

export function memoryQuery(revision: number, tick: number): AgentMemoryQuery {
  return {
    scope: {
      worldId: memoryWorldId,
      branchId: memoryBranchId,
      agentId: memoryAgentId,
    },
    revision,
    frontier: {
      worldSeq: 100,
      worldTick: tick,
      observationSeq: 2,
      perceptionRevision: 1,
      memoryRevision: revision,
      conversationCursor: null,
      knowledgeGrantRevision: 1,
    },
    counterpartIds: ["player-1"],
    queryTags: ["agreement", "breach", "evidence"],
    queryText: "承诺与证据",
    nodeId: null,
    purpose: "decision",
    audience: [memoryAgentId],
    maxItems: 6,
    maxTokens: 200,
  };
}

export function recordView(row: {
  readonly memoryId: string;
  readonly kind: MemoryRecordView["kind"];
  readonly tier: MemoryRecordView["tier"];
  readonly status: MemoryRecordView["status"];
  readonly epistemic: MemoryRecordView["epistemic"];
  readonly releasePolicyId: string;
  readonly validFromTick: number;
  readonly validUntilTick: number | null;
  readonly strength: number;
  readonly salience: number;
  readonly recallCount: number;
  readonly lastReinforcedTick: number;
  readonly tags: readonly string[];
  readonly sourceObservationIds: readonly string[];
  readonly content: MemoryRecordView["content"];
}, rowVersion = 1): MemoryRecordView {
  return { ...row, rowVersion };
}

export function revisionView(
  revision: number,
  records: readonly MemoryRecordView[],
): RevisionView {
  return {
    scope: {
      worldId: memoryWorldId,
      branchId: memoryBranchId,
      agentId: memoryAgentId,
    },
    revision,
    identity: memoryIdentity,
    records,
  };
}
