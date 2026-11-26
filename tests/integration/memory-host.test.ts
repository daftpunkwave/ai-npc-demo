/**
 * 验证记忆摄入、不可变 revision、整理租约、CAS rebase 与唤醒。
 * 依赖真实 SQLite 存储与确定性记忆模块。
 * 禁止绕过记忆宿主，或直接改写 revision 行。
 */
import { describe, expect, it } from "vitest";
import {
  capabilityIdSchema,
  emptyModuleConfigSchema,
  type AgentObservation,
  type MaintenanceTask,
  type MemoryChangePlan,
  type ModuleDefinition,
  type StorageRow,
} from "@world-prism/contracts";
import {
  createStatelessModule,
  defineModule,
  type MemoryPort,
  type MemoryRecordView,
} from "@world-prism/module-sdk";
import { MemoryHost } from "@world-prism/agent-runtime";
import {
  memoryLedgerModuleDefinition,
} from "@world-prism/mod-agent-memory-ledger";
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

async function startedHost(
  harness: MemoryHarness,
): Promise<MemoryHost> {
  const memory = new MemoryHost({
    storage: harness.storage,
    host: harness.host,
    roster: harness.roster,
    profiles: new Map([[memoryAgentId, harness.profile]]),
    moduleDefinitions: harness.definitions,
    identities: new Map([[memoryAgentId, memoryIdentity]]),
    worldId: memoryWorldId,
    branchId: memoryBranchId,
    runId: memoryRunId,
    signal: new AbortController().signal,
    maintenanceLeaseMs: 120_000,
    maintenanceConcurrency: 1,
  });
  await memory.start();
  return memory;
}

function closeHosts(hosts: readonly MemoryHost[], harnesses: readonly MemoryHarness[]): Promise<void> {
  return (async () => {
    for (const host of [...hosts].reverse()) await host.dispose();
    for (const harness of [...harnesses].reverse()) await harness.dispose();
  })();
}

describe("Agent memory host", () => {
  it("deduplicates delivery and preserves reconstructible revisions", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    const host = await startedHost(harness);
    try {
      insertObservation(harness, {
        sequence: 1,
        tick: 10,
        eventType: "AgreementBreached",
        summary: "岑雁违约",
        facts: {
          agreementId: "agr-000000000001",
          termIndex: 0,
          obligorId: "player-1",
          term: { kind: "deliver", obligorId: "player-1" },
        },
      });
      await host.ingestAll(10);
      expect(host.watermark(memoryAgentId)).toMatchObject({
        revision: 1,
        observationSeqConsumed: 1,
      });
      const atRevisionOne = host.retrieve(memoryAgentId, memoryQuery(1, 10));
      expect(atRevisionOne.relationSummary[0]).toMatchObject({
        targetId: "player-1",
        trust: -8,
        causes: ["breach"],
      });

      await host.ingestAll(10);
      expect(host.watermark(memoryAgentId).revision).toBe(1);

      insertObservation(harness, {
        sequence: 2,
        tick: 11,
        eventType: "InformationShared",
        summary: "收到新证据",
        facts: { evidenceId: "ev-exchange-draft", fromId: "player-1" },
      });
      await host.ingestAll(11);
      expect(host.watermark(memoryAgentId)).toMatchObject({
        revision: 2,
        observationSeqConsumed: 2,
      });
      expect(harness.storage.transact((tx) =>
        tx.branch(memoryBranchId)
          .table("memory_revisions")
          .list({ agent_id: memoryAgentId }, { orderBy: [{ column: "revision" }] })
          .map((row) => ({
            revision: row["revision"],
            base: row["base_revision"],
          })),
      )).toEqual([
        { revision: 0, base: 0 },
        { revision: 1, base: 0 },
        { revision: 2, base: 1 },
      ]);

      const oldView = host.retrieve(memoryAgentId, memoryQuery(1, 11));
      const newView = host.retrieve(memoryAgentId, memoryQuery(2, 11));
      expect(oldView.items.some((item) => item.summaryZh === "收到新证据")).toBe(false);
      expect(newView.items.some((item) => item.summaryZh === "收到新证据")).toBe(true);
      const cited = oldView.items[0];
      if (cited === undefined) throw new Error("expected a retrieved memory to cite");
      await expect(host.recordUse(memoryAgentId, {
        baseRevision: 2,
        turnId: "turn-000000000001",
        retrievedMemoryIds: [],
        citedMemoryIds: [cited.memoryId],
        noteworthy: [],
        inputObservations: [],
        worldTick: 11,
      })).rejects.toThrow("not retrieved");
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("emits one prospective trigger when the memory deadline becomes due", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    const host = await startedHost(harness);
    try {
      insertObservation(harness, {
        sequence: 1,
        tick: 10,
        eventType: "AgreementActivated",
        summary: "答应玩家送药",
        facts: {
          agreementId: "agr-000000000001",
          version: 1,
          parties: [memoryAgentId, "player-1"],
          terms: [{
            kind: "deliver",
            obligorId: memoryAgentId,
            resource: "medical",
            amount: 2,
            fromStockpileId: "sp-grayharbor",
            toStockpileId: "sp-pass",
            byTick: 20,
          }],
        },
      });
      await host.ingestAll(10);
      host.proposeDueWakeups(13);
      expect(triggers(harness)).toHaveLength(0);
      host.proposeDueWakeups(14);
      host.proposeDueWakeups(14);
      expect(triggers(harness)).toEqual([
        expect.objectContaining({
          kind: "prospective",
          priority: 50,
          created_tick: 14,
        }),
      ]);
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("requeues a leased maintenance task after restart and records derived progress", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    insertObservation(harness, {
      sequence: 1,
      tick: 24,
      eventType: "DayPassed",
      summary: "第 2 日结算完成",
      facts: { day: 2 },
      channel: "public-notice",
    });
    const task: MaintenanceTask = {
      moduleId: memoryLedgerModuleDefinition.id,
      trigger: "day-passed",
      dueTick: 24,
      baseRevision: 0,
      observationSeqThrough: 1,
      day: 2,
      needsModel: false,
    };
    harness.storage.transact((tx) => {
      tx.rows("maintenance_runs").put({
        maintenance_id: "mnt-000000000001",
        run_id: memoryRunId,
        branch_id: memoryBranchId,
        agent_id: memoryAgentId,
        module_id: memoryLedgerModuleDefinition.id,
        status: "leased",
        trigger: task.trigger,
        due_tick: task.dueTick,
        observation_seq_through: task.observationSeqThrough,
        task_json: task as never,
        base_revision: 0,
        lease_epoch: 2,
        lease_expires_at: "2025-01-01T00:00:00.000Z",
        error_json: null,
        created_at: harness.host.nowIso(),
        ended_at: null,
      });
    });
    const host = await startedHost(harness);
    try {
      await host.runDueMaintenance(24);
      expect(maintenanceRows(harness)).toEqual([
        expect.objectContaining({ status: "queued" }),
      ]);
      expect(host.watermark(memoryAgentId).derivedThroughTick).toBe(0);
      await host.ingestAll(24);
      // 首轮延期把任务重排到下一个逻辑 tick，避免未就绪任务在同一 tick 内被反复认领。
      await host.runDueMaintenance(25);
      const row = harness.storage.transact((tx) =>
        tx.rows("maintenance_runs").list({ branch_id: memoryBranchId }),
      );
      expect(row).toEqual([
        expect.objectContaining({ status: "completed", lease_epoch: 4 }),
      ]);
      expect(host.watermark(memoryAgentId)).toMatchObject({
        revision: 2,
        derivedThroughSeq: 1,
        derivedThroughTick: 24,
      });
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("retries a failed maintenance task on restart before the attempt limit", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    insertObservation(harness, {
      sequence: 1,
      tick: 24,
      eventType: "DayPassed",
      summary: "第 2 日结算完成",
      facts: { day: 2 },
      channel: "public-notice",
    });
    const task: MaintenanceTask = {
      moduleId: memoryLedgerModuleDefinition.id,
      trigger: "day-passed",
      dueTick: 24,
      baseRevision: 0,
      observationSeqThrough: 1,
      day: 2,
      needsModel: false,
    };
    harness.storage.transact((tx) => {
      tx.rows("maintenance_runs").put({
        maintenance_id: "mnt-000000000002",
        run_id: memoryRunId,
        branch_id: memoryBranchId,
        agent_id: memoryAgentId,
        module_id: memoryLedgerModuleDefinition.id,
        status: "failed",
        trigger: task.trigger,
        due_tick: task.dueTick,
        observation_seq_through: task.observationSeqThrough,
        task_json: task as never,
        base_revision: 0,
        lease_epoch: 1,
        lease_expires_at: null,
        error_json: { message: "transient" },
        created_at: harness.host.nowIso(),
        ended_at: harness.host.nowIso(),
      });
    });
    const host = await startedHost(harness);
    try {
      expect(maintenanceRows(harness)).toEqual([
        expect.objectContaining({ status: "queued" }),
      ]);
      await host.ingestAll(24);
      await host.runDueMaintenance(24);
      expect(maintenanceRows(harness)).toEqual([
        expect.objectContaining({ status: "completed", lease_epoch: 2 }),
      ]);
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("rebases an expired maintenance plan when unrelated memory changed", async () => {
    const scripted = scriptedMemory();
    const harness = await createMemoryHarness(scripted.definition);
    const host = await startedHost(harness);
    try {
      insertObservation(harness, { sequence: 1, tick: 0, eventType: "CreateA", summary: "A0" });
      insertObservation(harness, { sequence: 2, tick: 1, eventType: "DayPassed", summary: "day" });
      await host.ingestAll(1);
      const maintenance = host.runDueMaintenance(1);
      await scripted.firstStarted;
      insertObservation(harness, { sequence: 3, tick: 2, eventType: "CreateB", summary: "B0" });
      await host.ingestAll(2);
      scripted.release();
      await maintenance;

      expect(host.watermark(memoryAgentId).revision).toBe(3);
      expect(scripted.calls()).toBe(1);
      expect(maintenanceRows(harness)).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
      expect(recordText(harness, "mem-000000000010")).toBe("A-updated");
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("regenerates a conflicting maintenance plan against the latest revision", async () => {
    const scripted = scriptedMemory();
    const harness = await createMemoryHarness(scripted.definition);
    const host = await startedHost(harness);
    try {
      insertObservation(harness, { sequence: 1, tick: 0, eventType: "CreateA", summary: "A0" });
      insertObservation(harness, { sequence: 2, tick: 1, eventType: "DayPassed", summary: "day" });
      await host.ingestAll(1);
      const maintenance = host.runDueMaintenance(1);
      await scripted.firstStarted;
      insertObservation(harness, { sequence: 3, tick: 2, eventType: "CreateA", summary: "A-new" });
      await host.ingestAll(2);
      scripted.release();
      await maintenance;

      expect(host.watermark(memoryAgentId).revision).toBe(3);
      expect(scripted.calls()).toBe(2);
      expect(maintenanceRows(harness)).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
      expect(recordText(harness, "mem-000000000010")).toBe("A-updated");
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("persists the regenerated observation range into the task row", async () => {
    const scripted = scriptedMemory();
    const harness = await createMemoryHarness(scripted.definition);
    const host = await startedHost(harness);
    try {
      insertObservation(harness, { sequence: 1, tick: 0, eventType: "CreateA", summary: "A0" });
      insertObservation(harness, { sequence: 2, tick: 1, eventType: "DayPassed", summary: "day" });
      await host.ingestAll(1);
      const maintenance = host.runDueMaintenance(1);
      await scripted.firstStarted;
      insertObservation(harness, { sequence: 3, tick: 2, eventType: "CreateA", summary: "A-new" });
      await host.ingestAll(2);
      scripted.release();
      await maintenance;

      // 重算前版本：摄入扩大观察范围到 3；任务行与 task_json 必须同步，避免下次认领回退。
      expect(scripted.calls()).toBe(2);
      const [row] = maintenanceRows(harness);
      expect(row).toMatchObject({ status: "completed", observation_seq_through: 3 });
      expect((row?.["task_json"] as { observationSeqThrough?: number }).observationSeqThrough).toBe(3);
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("regenerates recordUse after its target changes during plan publication", async () => {
    const scripted = scriptedMemory();
    const harness = await createMemoryHarness(scripted.definition);
    const host = await startedHost(harness);
    try {
      const original = insertObservation(harness, {
        sequence: 1,
        tick: 0,
        eventType: "CreateA",
        summary: "A0",
      });
      await host.ingestAll(0);
      let releaseHash: (() => void) | null = null;
      let hashStartedResolve: (() => void) | null = null;
      const hashStarted = new Promise<void>((resolve) => {
        hashStartedResolve = resolve;
      });
      const hashGate = new Promise<void>((resolve) => {
        releaseHash = resolve;
      });
      const originalHash = harness.host.hash;
      let blocked = false;
      harness.host.hash = async (value) => {
        if (!blocked) {
          blocked = true;
          hashStartedResolve?.();
          await hashGate;
        }
        return originalHash(value);
      };

      const use = host.recordUse(memoryAgentId, {
        baseRevision: 1,
        turnId: "turn-000000000001",
        retrievedMemoryIds: ["mem-000000000010"],
        citedMemoryIds: ["mem-000000000010"],
        noteworthy: [],
        inputObservations: [original],
        worldTick: 2,
      });
      await hashStarted;
      insertObservation(harness, {
        sequence: 2,
        tick: 2,
        eventType: "CreateA",
        summary: "A-new",
      });
      await host.ingestAll(2);
      (releaseHash as unknown as () => void)();
      await use;

      expect(host.watermark(memoryAgentId).revision).toBe(3);
      expect(scripted.useCalls()).toBe(2);
      expect(recordText(harness, "mem-000000000010")).toBe("A-used");
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("ingests every pending observation in sequence order in a single pass", async () => {
    const harness = await createMemoryHarness(memoryLedgerModuleDefinition);
    const host = await startedHost(harness);
    try {
      insertObservation(harness, { sequence: 1, tick: 1, eventType: "CreateA", summary: "A0" });
      insertObservation(harness, { sequence: 2, tick: 2, eventType: "MetersChanged", summary: "B0" });
      insertObservation(harness, { sequence: 3, tick: 3, eventType: "CreateB", summary: "C0" });
      await host.ingestAll(3);
      // 一次 ingestAll 覆盖水位之后的全部观察：缺一条都会让水位停在中间。
      expect(host.watermark(memoryAgentId)).toMatchObject({
        revision: 1,
        observationSeqConsumed: 3,
      });
    } finally {
      await closeHosts([host], [harness]);
    }
  });
});

describe("Memory use publication", () => {
  it("accepts a replacement memory that declares the source turn without a private data key", async () => {
    const harness = await createMemoryHarness(sourceTurnMemory({ sourceTurnId: "turn-000000000001" }));
    const host = await startedHost(harness);
    try {
      const observation = insertObservation(harness, {
        sequence: 1,
        tick: 0,
        eventType: "CreateA",
        summary: "A0",
      });
      await host.ingestAll(0);
      await expect(host.recordUse(memoryAgentId, {
        baseRevision: 1,
        turnId: "turn-000000000001",
        retrievedMemoryIds: [],
        citedMemoryIds: [],
        noteworthy: [],
        inputObservations: [observation],
        worldTick: 1,
      })).resolves.toBe(2);
      expect(host.watermark(memoryAgentId).revision).toBe(2);
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("rejects a use plan whose record declares another source turn", async () => {
    const harness = await createMemoryHarness(sourceTurnMemory({ sourceTurnId: "turn-000000000002" }));
    const host = await startedHost(harness);
    try {
      const observation = insertObservation(harness, {
        sequence: 1,
        tick: 0,
        eventType: "CreateA",
        summary: "A0",
      });
      await host.ingestAll(0);
      await expect(host.recordUse(memoryAgentId, {
        baseRevision: 1,
        turnId: "turn-000000000001",
        retrievedMemoryIds: [],
        citedMemoryIds: [],
        noteworthy: [],
        inputObservations: [observation],
        worldTick: 1,
      })).rejects.toThrow("source turn does not match");
      expect(host.watermark(memoryAgentId).revision).toBe(1);
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("rejects a use plan that omits the source turn", async () => {
    const harness = await createMemoryHarness(sourceTurnMemory());
    const host = await startedHost(harness);
    try {
      const observation = insertObservation(harness, {
        sequence: 1,
        tick: 0,
        eventType: "CreateA",
        summary: "A0",
      });
      await host.ingestAll(0);
      await expect(host.recordUse(memoryAgentId, {
        baseRevision: 1,
        turnId: "turn-000000000001",
        retrievedMemoryIds: [],
        citedMemoryIds: [],
        noteworthy: [],
        inputObservations: [observation],
        worldTick: 1,
      })).rejects.toThrow("source turn does not match");
      expect(host.watermark(memoryAgentId).revision).toBe(1);
    } finally {
      await closeHosts([host], [harness]);
    }
  });

  it("rejects a use plan that cites an observation outside this turn's inputs", async () => {
    const harness = await createMemoryHarness(sourceTurnMemory({
      sourceTurnId: "turn-000000000001",
      sourceObservationIds: ["obs-000000000002"],
    }));
    const host = await startedHost(harness);
    try {
      const first = insertObservation(harness, {
        sequence: 1,
        tick: 0,
        eventType: "CreateA",
        summary: "A0",
      });
      insertObservation(harness, {
        sequence: 2,
        tick: 1,
        eventType: "CreateB",
        summary: "B0",
      });
      await host.ingestAll(1);
      await expect(host.recordUse(memoryAgentId, {
        baseRevision: 1,
        turnId: "turn-000000000001",
        retrievedMemoryIds: [],
        citedMemoryIds: [],
        noteworthy: [],
        inputObservations: [first],
        worldTick: 2,
      })).rejects.toThrow("not derived from this turn");
      expect(host.watermark(memoryAgentId).revision).toBe(1);
    } finally {
      await closeHosts([host], [harness]);
    }
  });
});

function sourceTurnMemory(options: {
  readonly sourceTurnId?: string;
  readonly sourceObservationIds?: readonly string[];
} = {}): ModuleDefinition {
  const base = memoryRecord();
  const port: MemoryPort = {
    prepareIngest(input) {
      return {
        baseRevision: input.baseRevision,
        observationSeqThrough: input.observations.reduce(
          (highest, observation) => Math.max(highest, observation.observationSeq),
          0,
        ),
        inserts: [],
        retires: [],
        derivedThroughSeq: null,
        derivedThroughTick: null,
        changeKind: "ingest",
      };
    },
    retrieve(query) {
      return {
        status: "empty-by-design",
        revision: query.revision,
        coreBlock: null,
        relationSummary: [],
        items: [],
        candidates: 0,
        dropped: [],
      };
    },
    planMaintenance() {
      return null;
    },
    async runMaintenance() {
      throw new Error("source-turn memory does not run maintenance");
    },
    recordUse(input) {
      const sourceObservationIds = (options.sourceObservationIds ??
        input.inputObservations.map((observation) => observation.observationId)) as
        MemoryChangePlan["inserts"][number]["sourceObservationIds"];
      return {
        baseRevision: input.baseRevision,
        observationSeqThrough: input.inputObservations.reduce(
          (highest, observation) => Math.max(highest, observation.observationSeq),
          0,
        ),
        inserts: [{
          ...base,
          memoryId: "mem-000000000020" as MemoryChangePlan["inserts"][number]["memoryId"],
          validFromTick: input.worldTick,
          lastReinforcedTick: input.worldTick,
          sourceObservationIds,
          ...(options.sourceTurnId === undefined ? {} : { sourceTurnId: options.sourceTurnId }),
          content: {
            summaryZh: "替代记忆实现写入的记录",
            counterpartIds: ["player-1"],
            data: { marker: "alternative" },
          },
        }],
        retires: [],
        derivedThroughSeq: null,
        derivedThroughTick: null,
        changeKind: "use",
      };
    },
    proposeWakeups() {
      return [];
    },
  };
  return defineModule({
    id: "agent.memory.source-turn",
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "agent",
    provides: [{
      capability: capabilityIdSchema.parse("agent.memory"),
      cardinality: "exactly-one",
      instanceScope: "agent",
    }],
    requires: [],
    requiresRemote: [],
    configSchema: emptyModuleConfigSchema,
    defaults: {},
    stateSchemaVersion: 1,
    migrationPaths: [],
    create: async (input) => createStatelessModule(input, port),
  });
}

function triggers(harness: MemoryHarness): readonly StorageRow[] {
  return harness.storage.transact((tx) =>
    tx.branch(memoryBranchId).table("triggers").list(),
  );
}

function maintenanceRows(harness: MemoryHarness): readonly StorageRow[] {
  return harness.storage.transact((tx) =>
    tx.rows("maintenance_runs").list({ branch_id: memoryBranchId }),
  );
}

function recordText(harness: MemoryHarness, memoryId: string): unknown {
  return harness.storage.transact((tx) => {
    const row = tx.branch(memoryBranchId).table("memory_records").list({
      agent_id: memoryAgentId,
      memory_id: memoryId,
    }).find((candidate) => candidate["retired_revision"] === null);
    const content = row?.["content_json"];
    if (
      typeof content !== "object" ||
      content === null ||
      Array.isArray(content) ||
      content instanceof Uint8Array
    ) {
      return undefined;
    }
    const data = content["data"];
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data["marker"] : undefined;
  });
}

function scriptedMemory(): {
  readonly definition: ModuleDefinition;
  readonly firstStarted: Promise<void>;
  readonly release: () => void;
  readonly calls: () => number;
  readonly useCalls: () => number;
} {
  let callCount = 0;
  let useCount = 0;
  let startedResolve: (() => void) | null = null;
  const firstStarted = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let releaseMaintenance: (() => void) | null = null;
  const releaseGate = new Promise<void>((resolve) => {
    releaseMaintenance = resolve;
  });
  const base = memoryRecord();
  const port: MemoryPort = {
    prepareIngest(input, view) {
      const inserts: MemoryChangePlan["inserts"][number][] = [];
      const retires: MemoryChangePlan["retires"] = [];
      for (const observation of input.observations) {
        const eventType = observationObject(observation)["eventType"];
        if (eventType !== "CreateA" && eventType !== "CreateB") continue;
        const memoryId = eventType === "CreateA" ? "mem-000000000010" : "mem-000000000011";
        const existing = view.records.find((record) => record.memoryId === memoryId);
        if (existing !== undefined) retires.push({ memoryId, status: "superseded" });
        inserts.push({
          ...base,
          memoryId: memoryId as MemoryChangePlan["inserts"][number]["memoryId"],
          content: {
            summaryZh: String(observationObject(observation)["summaryZh"] ?? eventType),
            counterpartIds: ["player-1"],
            data: {
              marker: String(observationObject(observation)["summaryZh"] ?? eventType),
              eventType: String(eventType),
            },
          },
          sourceObservationIds: [observation.observationId],
          validFromTick: observation.knownAtTick,
          lastReinforcedTick: observation.knownAtTick,
        });
      }
      return {
        baseRevision: input.baseRevision,
        observationSeqThrough: Math.max(...input.observations.map((observation) => observation.observationSeq)),
        inserts,
        retires,
        derivedThroughSeq: null,
        derivedThroughTick: null,
        changeKind: "ingest",
      };
    },
    retrieve(query) {
      return {
        status: "empty-by-design",
        revision: query.revision,
        coreBlock: null,
        relationSummary: [],
        items: [],
        candidates: 0,
        dropped: [],
      };
    },
    planMaintenance(input) {
      if (input.trigger !== "day-passed") return null;
      return {
        moduleId: "agent.memory.scripted",
        trigger: "day-passed",
        dueTick: input.worldTick,
        baseRevision: input.revision,
        observationSeqThrough: input.observationSeqThrough,
        day: 1,
        needsModel: false,
      };
    },
    async runMaintenance(task, view) {
      callCount += 1;
      if (callCount === 1) {
        startedResolve?.();
        await releaseGate;
      }
      const current = view.records.find((record) => record.memoryId === "mem-000000000010");
      if (current === undefined) throw new Error("scripted memory A is missing");
      return {
        baseRevision: task.baseRevision,
        observationSeqThrough: task.observationSeqThrough,
        inserts: [{
          memoryId: current.memoryId as MemoryChangePlan["inserts"][number]["memoryId"],
          kind: current.kind,
          tier: current.tier,
          status: "active",
          epistemic: current.epistemic,
          releasePolicyId: current.releasePolicyId,
          validFromTick: current.validFromTick,
          validUntilTick: null,
          strength: current.salience,
          salience: current.salience,
          recallCount: current.recallCount,
          lastReinforcedTick: task.dueTick,
          tags: [...current.tags],
          sourceObservationIds: [...current.sourceObservationIds],
          content: {
            summaryZh: current.content.summaryZh,
            counterpartIds: [...current.content.counterpartIds],
            data: { ...objectData(current), marker: "A-updated" },
          },
        }],
        retires: [{ memoryId: current.memoryId, status: "superseded" }],
        derivedThroughSeq: task.observationSeqThrough,
        derivedThroughTick: task.dueTick,
        changeKind: "maintenance",
      };
    },
    recordUse(input, view) {
      useCount += 1;
      const current = view.records.find((record) => record.memoryId === "mem-000000000010");
      if (current === undefined) throw new Error("scripted memory A is missing");
      return {
        baseRevision: input.baseRevision,
        observationSeqThrough: input.inputObservations.reduce(
          (highest, observation) => Math.max(highest, observation.observationSeq),
          0,
        ),
        inserts: [{
          memoryId: current.memoryId as MemoryChangePlan["inserts"][number]["memoryId"],
          kind: current.kind,
          tier: current.tier,
          status: "active",
          epistemic: current.epistemic,
          releasePolicyId: current.releasePolicyId,
          validFromTick: current.validFromTick,
          validUntilTick: null,
          strength: current.salience,
          salience: current.salience,
          recallCount: current.recallCount + 1,
          lastReinforcedTick: input.worldTick,
          tags: [...current.tags],
          sourceObservationIds: [...current.sourceObservationIds],
          content: {
            summaryZh: current.content.summaryZh,
            counterpartIds: [...current.content.counterpartIds],
            data: { ...objectData(current), marker: "A-used" },
          },
        }],
        retires: [{ memoryId: current.memoryId, status: "superseded" }],
        derivedThroughSeq: null,
        derivedThroughTick: null,
        changeKind: "use",
      };
    },
    proposeWakeups() {
      return [];
    },
  };
  const definition = defineModule({
    id: "agent.memory.scripted",
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "agent",
    provides: [{
      capability: capabilityIdSchema.parse("agent.memory"),
      cardinality: "exactly-one",
      instanceScope: "agent",
    }],
    requires: [],
    requiresRemote: [],
    configSchema: emptyModuleConfigSchema,
    defaults: {},
    stateSchemaVersion: 1,
    migrationPaths: [],
    create: async (input) => createStatelessModule(input, port),
  });
  return {
    definition,
    firstStarted,
    release: () => releaseMaintenance?.(),
    calls: () => callCount,
    useCalls: () => useCount,
  };
}

function memoryRecord(): Omit<MemoryChangePlan["inserts"][number], "memoryId" | "content" | "sourceObservationIds" | "validFromTick" | "lastReinforcedTick"> {
  return {
    kind: "episodic",
    tier: "long",
    status: "active",
    epistemic: "verified-event",
    releasePolicyId: "parties:human-independent,player-1",
    validUntilTick: null,
    strength: 1,
    salience: 1,
    recallCount: 0,
    tags: ["test"],
  };
}

function observationObject(observation: AgentObservation): Readonly<Record<string, unknown>> {
  return typeof observation.content === "object" &&
    observation.content !== null &&
    !Array.isArray(observation.content)
    ? observation.content as Readonly<Record<string, unknown>>
    : {};
}

function objectData(record: MemoryRecordView): Readonly<Record<string, unknown>> {
  return typeof record.content.data === "object" &&
    record.content.data !== null &&
    !Array.isArray(record.content.data)
    ? record.content.data as Readonly<Record<string, unknown>>
    : {};
}
