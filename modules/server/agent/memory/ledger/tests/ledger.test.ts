/**
 * 验证结构化账本的摄入、关系、检索、强化与唤醒建议。
 * Verifies structured-ledger ingestion, relations, recall, usage, and wake-up proposals.
 * Depends on deterministic IDs and frozen revision fixtures.
 * Must not use SQLite or model transports.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentMemoryQuery,
  AgentObservation,
  Json,
  MemoryChangePlan,
} from "@ai-npc/contracts";
import type {
  MemoryAgentIdentity,
  MemoryRecordView,
  RevisionView,
} from "@ai-npc/module-sdk";
import { ledgerConfigSchema, memoryLedgerModuleDefinition } from "../src/definition";
import { createLedgerPort } from "../src/ledger-port";

const scope = {
  worldId: "wld-000000000001",
  branchId: "br-000000000001",
  agentId: "human-independent",
};

const identity: MemoryAgentIdentity = {
  factionId: "human-independent",
  values: ["重约", "怕封锁"],
  initialRelations: [],
  personalityKeywords: {
    agreement: ["约"],
    rescue: ["救"],
    resource: ["供给"],
    road: ["封锁"],
    evidence: ["证据"],
  },
};

let idSequence = 0;

function ids(prefix: string): string {
  idSequence += 1;
  return `${prefix}-${idSequence.toString(32).padStart(12, "0")}`;
}

function observation(input: {
  readonly id: string;
  readonly seq: number;
  readonly tick: number;
  readonly eventType: string;
  readonly channel?: string;
  readonly facts?: Json;
  readonly subjectIds?: readonly string[];
  readonly summary?: string;
}): AgentObservation {
  return {
    observationId: input.id as AgentObservation["observationId"],
    scope,
    observationSeq: input.seq,
    sourceEventIds: [`evt-${String(input.seq).padStart(12, "0")}` as AgentObservation["sourceEventIds"][number]],
    sourceObservationIds: [],
    occurredAtTick: input.tick,
    sensedAtTick: input.tick,
    knownAtTick: input.tick,
    channel: input.channel ?? "party",
    epistemic: "witnessed",
    confidence: 1,
    releasePolicyId: "parties:human-independent,player-1",
    content: {
      eventType: input.eventType,
      summaryZh: input.summary ?? input.eventType,
      subjectIds: [...(input.subjectIds ?? ["player-1"])],
      nodeId: null,
      refs: {},
      facts: input.facts ?? {},
      claim: null,
      detail: "full",
    },
  };
}

function view(records: readonly MemoryRecordView[] = [], revision = 0): RevisionView {
  return { scope, revision, identity, records };
}

function asViews(plan: MemoryChangePlan, revision = 1): readonly MemoryRecordView[] {
  return plan.inserts.map((row) => ({
    ...row,
    rowVersion: 1,
    tags: [...row.tags],
    sourceObservationIds: [...row.sourceObservationIds],
    content: {
      ...row.content,
      counterpartIds: [...row.content.counterpartIds],
    },
  }));
}

function query(overrides: Partial<AgentMemoryQuery> = {}): AgentMemoryQuery {
  return {
    scope,
    revision: 1,
    frontier: {
      worldSeq: 10,
      worldTick: 20,
      observationSeq: 1,
      memoryRevision: 1,
      perceptionRevision: 1,
      knowledgeGrantRevision: 1,
      conversationCursor: null,
    },
    counterpartIds: ["player-1"],
    queryTags: ["agreement", "breach"],
    queryText: "承诺",
    nodeId: null,
    purpose: "decision",
    audience: ["human-independent"],
    maxItems: 6,
    maxTokens: 200,
    ...overrides,
  };
}

function port() {
  return createLedgerPort(
    ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults),
    ids,
  );
}

describe("structured ledger", () => {
  it("does not ingest the same observation twice", () => {
    const memory = port();
    const event = observation({
      id: "obs-000000000001",
      seq: 1,
      tick: 10,
      eventType: "InformationShared",
    });
    const first = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [event],
      worldTick: 10,
    }, view());
    expect(first.inserts.length).toBeGreaterThan(0);

    const second = memory.prepareIngest({
      scope,
      baseRevision: 1,
      observations: [event],
      worldTick: 10,
    }, view(asViews(first), 1));
    expect(second.inserts).toEqual([]);
    expect(second.retires).toEqual([]);
  });

  it("rejects a forged memory scope", () => {
    const memory = port();
    expect(() => memory.retrieve(query({
      scope: { ...scope, agentId: "npc-qilu" },
    }), view())).toThrow("memory scope");
  });

  it("records a breach as decaying relation causes", () => {
    const memory = port();
    const event = observation({
      id: "obs-000000000002",
      seq: 1,
      tick: 10,
      eventType: "AgreementBreached",
      summary: "岑雁没有按期送来药品",
      facts: {
        agreementId: "agr-000000000001",
        termIndex: 0,
        obligorId: "player-1",
        term: { kind: "deliver", obligorId: "player-1", resource: "medical", amount: 2 },
      },
    });
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [event],
      worldTick: 10,
    }, view());
    const bundle = memory.retrieve(query({
      frontier: { ...query().frontier, worldTick: 10 },
    }), view(asViews(plan), 1));
    expect(bundle.relationSummary[0]).toMatchObject({
      targetId: "player-1",
      trust: -8,
      affinity: -3,
      causes: ["breach"],
    });
    expect(bundle.relationSummary[0]?.reasonMemoryIds).toHaveLength(2);
  });

  it("proposes a self promise wake-up six ticks before its deadline", () => {
    const memory = port();
    const event = observation({
      id: "obs-000000000003",
      seq: 1,
      tick: 10,
      eventType: "AgreementActivated",
      facts: {
        agreementId: "agr-000000000001",
        version: 1,
        parties: ["human-independent", "player-1"],
        terms: [{
          kind: "deliver",
          obligorId: "human-independent",
          resource: "supply",
          amount: 2,
          fromStockpileId: "sp-grayharbor",
          toStockpileId: "sp-pass",
          byTick: 20,
        }],
      },
    });
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [event],
      worldTick: 10,
    }, view());
    const frozen = view(asViews(plan), 1);
    expect(memory.proposeWakeups({
      scope,
      revision: 1,
      worldTick: 13,
    }, frozen)).toEqual([]);
    expect(memory.proposeWakeups({
      scope,
      revision: 1,
      worldTick: 14,
    }, frozen)).toEqual([
      expect.objectContaining({ atTick: 14, reason: "self-due" }),
    ]);
  });

  it("closes a promise activated and fulfilled in the same ingest batch", () => {
    const memory = port();
    const activated = observation({
      id: "obs-000000000021",
      seq: 1,
      tick: 10,
      eventType: "AgreementActivated",
      facts: {
        agreementId: "agr-000000000001",
        version: 1,
        parties: ["human-independent", "player-1"],
        terms: [{
          kind: "deliver",
          obligorId: "human-independent",
          resource: "supply",
          amount: 2,
          fromStockpileId: "sp-grayharbor",
          toStockpileId: "sp-pass",
          byTick: 20,
        }],
      },
    });
    const fulfilled = observation({
      id: "obs-000000000022",
      seq: 2,
      tick: 11,
      eventType: "AgreementTermFulfilled",
      facts: {
        agreementId: "agr-000000000001",
        termIndex: 0,
        obligorId: "human-independent",
        term: {
          kind: "deliver",
          obligorId: "human-independent",
          resource: "supply",
          amount: 2,
          fromStockpileId: "sp-grayharbor",
          toStockpileId: "sp-pass",
          byTick: 20,
        },
        evidenceEventIds: [],
      },
    });
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [activated, fulfilled],
      worldTick: 11,
    }, view());
    const promises = plan.inserts.filter((row) => row.kind === "prospective");
    expect(promises).toHaveLength(1);
    expect(promises[0]?.status).toBe("superseded");
    expect(plan.retires.map((row) => row.memoryId)).not.toContain(promises[0]?.memoryId);
  });

  it("reinforces only cited records", () => {
    const memory = port();
    const events = [
      observation({
        id: "obs-000000000004",
        seq: 1,
        tick: 10,
        eventType: "InformationShared",
        summary: "收到证据一",
      }),
      observation({
        id: "obs-000000000005",
        seq: 2,
        tick: 11,
        eventType: "InformationShared",
        summary: "收到证据二",
      }),
    ];
    const ingested = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: events,
      worldTick: 11,
    }, view());
    const records = asViews(ingested, 1);
    const cited = records[0];
    expect(cited).toBeDefined();
    const used = memory.recordUse({
      scope,
      baseRevision: 1,
      turnId: "turn-000000000001",
      citedMemoryIds: [cited!.memoryId],
      noteworthy: [],
      inputObservations: events,
      worldTick: 12,
    }, view(records, 1));
    expect(used.inserts.map((row) => row.memoryId)).toEqual([cited!.memoryId]);
    expect(used.inserts[0]?.recallCount).toBe(1);
  });

  it("summarizes low-salience observations without preserving each detail", () => {
    const memory = port();
    const events = [
      observation({
        id: "obs-000000000006",
        seq: 1,
        tick: 10,
        eventType: "RumorSpread",
        channel: "broadcast",
        summary: "传闻一",
      }),
      observation({
        id: "obs-000000000007",
        seq: 2,
        tick: 11,
        eventType: "RumorSpread",
        channel: "broadcast",
        summary: "传闻二",
      }),
    ];
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: events,
      worldTick: 11,
    }, view());
    const aggregates = plan.inserts.filter((row) => row.content.data !== null &&
      typeof row.content.data === "object" &&
      !Array.isArray(row.content.data) &&
      row.content.data["aggregate"] === true);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.sourceObservationIds).toEqual([
      "obs-000000000006",
      "obs-000000000007",
    ]);
  });

  it("adjudicates model-reported points against the current turn observations", () => {
    const memory = port();
    const source = observation({
      id: "obs-000000000008",
      seq: 1,
      tick: 12,
      eventType: "DialogueSubmitted",
      summary: "玩家说明明天会补交药品",
    });
    const valid = memory.recordUse({
      scope,
      baseRevision: 0,
      turnId: "turn-000000000001",
      citedMemoryIds: [],
      noteworthy: [{
        kind: "claim",
        aboutId: "player-1",
        summary: "玩家声称明天会补交药品",
        dueTick: null,
        sourceRefs: [source.observationId],
      }],
      inputObservations: [source],
      worldTick: 12,
    }, view());
    expect(valid.inserts).toHaveLength(1);
    expect(valid.inserts[0]?.epistemic).toBe("reported-claim");

    const invalid = memory.recordUse({
      scope,
      baseRevision: 0,
      turnId: "turn-000000000001",
      citedMemoryIds: [],
      noteworthy: [{
        kind: "promise-by-other",
        aboutId: "npc-qilu",
        summary: "祁录承诺送药",
        dueTick: 20,
        sourceRefs: [source.observationId],
      }, {
        kind: "request",
        aboutId: "player-1",
        summary: "不存在的来源",
        dueTick: null,
        sourceRefs: ["obs-000000000099"],
      }],
      inputObservations: [source],
      worldTick: 12,
    }, view());
    expect(invalid.inserts).toEqual([]);
  });

  it("expires stale details, sediments relations, and promotes salient long memory", async () => {
    const memory = port();
    const records: MemoryRecordView[] = [
      memoryRow({
        memoryId: "mem-000000000101",
        kind: "episodic",
        tier: "short",
        validFromTick: 0,
        salience: 0.3,
        data: { eventType: "DialogueSubmitted" },
      }),
      memoryRow({
        memoryId: "mem-000000000102",
        kind: "episodic",
        tier: "long",
        validFromTick: 0,
        salience: 0.95,
        data: { eventType: "WorldFactRecorded" },
      }),
      memoryRow({
        memoryId: "mem-000000000103",
        kind: "relation",
        tier: "long",
        validFromTick: 0,
        salience: 0.125,
        data: {
          relationTargetId: "player-1",
          dimension: "trust",
          delta: -1,
          cause: "breach",
          modifiedAtTick: 0,
          halfLifeTicks: 1,
        },
      }),
    ];
    const plan = await memory.runMaintenance({
      moduleId: "agent.memory.ledger",
      trigger: "day-passed",
      dueTick: 1000,
      baseRevision: 3,
      observationSeqThrough: 9,
      day: 42,
      needsModel: false,
    }, view(records, 3));
    expect(plan.derivedThroughSeq).toBe(9);
    expect(plan.derivedThroughTick).toBe(1000);
    expect(plan.retires).toContainEqual({
      memoryId: "mem-000000000101",
      status: "expired",
    });
    expect(plan.retires).toContainEqual({
      memoryId: "mem-000000000103",
      status: "expired",
    });
    expect(plan.inserts).toContainEqual(expect.objectContaining({
      memoryId: "mem-000000000102",
      tier: "core",
    }));
    expect(plan.inserts).toContainEqual(expect.objectContaining({
      memoryId: "mem-000000000103",
      content: expect.objectContaining({
        data: expect.objectContaining({ baseline: true }),
      }),
    }));
  });
});

function memoryRow(input: {
  readonly memoryId: string;
  readonly kind: MemoryRecordView["kind"];
  readonly tier: MemoryRecordView["tier"];
  readonly validFromTick: number;
  readonly salience: number;
  readonly data: Json;
}): MemoryRecordView {
  return {
    memoryId: input.memoryId,
    rowVersion: 1,
    kind: input.kind,
    tier: input.tier,
    status: "active",
    epistemic: "verified-event",
    releasePolicyId: "parties:human-independent,player-1",
    validFromTick: input.validFromTick,
    validUntilTick: null,
    strength: input.salience,
    salience: input.salience,
    recallCount: 0,
    lastReinforcedTick: input.validFromTick,
    tags: ["test"],
    sourceObservationIds: ["obs-000000000001"],
    content: {
      summaryZh: "测试记录",
      counterpartIds: ["player-1"],
      data: input.data,
    },
  };
}
