/**
 * 验证结构化账本的摄入、关系、检索、强化与唤醒建议。
 * 依赖确定性 ID 与冻结 revision 夹具。
 * 禁止使用 SQLite 或模型传输层。
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
  readonly epistemic?: AgentObservation["epistemic"];
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
    epistemic: input.epistemic ?? "witnessed",
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

function asViews(plan: MemoryChangePlan): readonly MemoryRecordView[] {
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

  it("applies candidateLimit after relevance scoring", () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.recall.candidateLimit = 1;
    config.recall.topK = 1;
    config.recall.mustIncludeAboutCounterpart = 0;
    const memory = createLedgerPort(config, ids);
    const records = [
      memoryRow({
        memoryId: "mem-000000000201",
        kind: "episodic",
        tier: "long",
        validFromTick: 1,
        salience: 0.5,
        data: { eventType: "MetersChanged" },
        tags: ["unrelated"],
      }),
      memoryRow({
        memoryId: "mem-000000000202",
        kind: "episodic",
        tier: "long",
        validFromTick: 1,
        salience: 0.5,
        data: { eventType: "AgreementActivated" },
        tags: ["agreement"],
      }),
    ];
    const bundle = memory.retrieve(query(), view(records, 1));
    expect(bundle.items.map((item) => item.memoryId)).toEqual(["mem-000000000202"]);
  });

  it("selects mandatory promises before applying the normal candidate limit", () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.recall.candidateLimit = 1;
    config.recall.topK = 1;
    config.recall.mustIncludeProspective = 1;
    const memory = createLedgerPort(config, ids);
    const records = [
      memoryRow({
        memoryId: "mem-000000000205",
        kind: "episodic",
        tier: "long",
        validFromTick: 19,
        salience: 0.9,
        data: { eventType: "AgreementActivated" },
        tags: ["agreement"],
        sourceObservationIds: ["obs-000000000201"],
      }),
      memoryRow({
        memoryId: "mem-000000000206",
        kind: "prospective",
        tier: "long",
        validFromTick: 1,
        salience: 0.1,
        data: {
          sourceKind: "agreement",
          obligorId: "human-independent",
          dueTick: 30,
          state: "open",
        },
        sourceObservationIds: ["obs-000000000202"],
      }),
    ];
    const bundle = memory.retrieve(query({ maxItems: 1 }), view(records, 1));
    expect(bundle.items[0]).toMatchObject({
      memoryId: "mem-000000000206",
      mustInclude: true,
    });
  });

  it("deduplicates mandatory records by source observation", () => {
    const memory = port();
    const records = [
      memoryRow({
        memoryId: "mem-000000000207",
        kind: "prospective",
        tier: "long",
        validFromTick: 1,
        salience: 0.5,
        data: {
          sourceKind: "agreement",
          obligorId: "human-independent",
          dueTick: 30,
          state: "open",
        },
        sourceObservationIds: ["obs-000000000203"],
      }),
      memoryRow({
        memoryId: "mem-000000000208",
        kind: "episodic",
        tier: "long",
        validFromTick: 1,
        salience: 0.9,
        data: { eventType: "AgreementActivated" },
        sourceObservationIds: ["obs-000000000203"],
      }),
    ];
    const bundle = memory.retrieve(query({ maxItems: 2 }), view(records, 1));
    expect(bundle.items.map((item) => item.memoryId)).toEqual(["mem-000000000207"]);
  });

  it("chooses about-counterpart mandatory records by salience", () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.recall.mustIncludeProspective = 0;
    config.recall.mustIncludeAboutCounterpart = 1;
    const memory = createLedgerPort(config, ids);
    const records = [
      memoryRow({
        memoryId: "mem-000000000212",
        kind: "episodic",
        tier: "long",
        validFromTick: 1,
        salience: 0.9,
        data: { eventType: "WorldFactRecorded" },
        sourceObservationIds: ["obs-000000000211"],
      }),
      memoryRow({
        memoryId: "mem-000000000213",
        kind: "episodic",
        tier: "long",
        validFromTick: 19,
        salience: 0.2,
        data: { eventType: "DialogueSubmitted" },
        sourceObservationIds: ["obs-000000000212"],
      }),
    ];
    const bundle = memory.retrieve(query({ maxItems: 1 }), view(records, 1));
    expect(bundle.items[0]?.memoryId).toBe("mem-000000000212");
  });

  it("counts mandatory items against the shared token budget", () => {
    const memory = port();
    const records = [
      memoryRow({
        memoryId: "mem-000000000203",
        kind: "prospective",
        tier: "long",
        validFromTick: 1,
        salience: 0.5,
        data: {
          sourceKind: "agreement",
          obligorId: "human-independent",
          dueTick: 30,
          state: "open",
        },
      }),
    ];
    const bundle = memory.retrieve(query({ maxTokens: 0 }), view(records, 1));
    expect(bundle.items).toEqual([]);
    expect(bundle.dropped).toContainEqual({
      memoryId: "mem-000000000203",
      reason: "budget",
    });
  });

  it("does not retire a relation row that was only created in the same plan", () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.relationModifiersPerTarget = 1;
    const memory = createLedgerPort(config, ids);
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [observation({
        id: "obs-000000000041",
        seq: 1,
        tick: 10,
        eventType: "AgreementBreached",
        facts: {
          agreementId: "agr-000000000001",
          termIndex: 0,
          obligorId: "player-1",
          term: { kind: "deliver", obligorId: "player-1" },
        },
      })],
      worldTick: 10,
    }, view());
    const relationIds = plan.inserts
      .filter((row) => row.kind === "relation")
      .map((row) => row.memoryId);
    expect(relationIds).toHaveLength(1);
    expect(plan.retires.map((row) => row.memoryId)).not.toContain(relationIds[0]);
  });

  it("removes a same-batch rumor correction when counter-evidence arrives", () => {
    const memory = port();
    const rumor = observation({
      id: "obs-000000000061",
      seq: 1,
      tick: 10,
      eventType: "RumorSpread",
      channel: "broadcast",
      epistemic: "reported",
      facts: { aboutIds: ["player-1"], tags: [] },
    });
    const counter = observation({
      id: "obs-000000000062",
      seq: 2,
      tick: 11,
      eventType: "WorldFactRecorded",
      facts: { tags: ["rumor-counter"] },
    });
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [rumor, counter],
      worldTick: 11,
    }, view());
    const relations = plan.inserts.filter((row) => row.kind === "relation");
    expect(relations.some((row) => dataObject(row.content.data)["cause"] === "rumor-hostile")).toBe(false);
    expect(relations).toContainEqual(expect.objectContaining({
      epistemic: "verified-event",
      content: expect.objectContaining({
        data: expect.objectContaining({ cause: "counter-evidence" }),
      }),
    }));
    expect(plan.retires.map((row) => row.memoryId)).not.toContain(relations[0]?.memoryId);
  });

  it("keeps reported rumor relations distinct from verified experience", () => {
    const memory = port();
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [observation({
        id: "obs-000000000064",
        seq: 1,
        tick: 10,
        eventType: "RumorSpread",
        channel: "broadcast",
        epistemic: "reported",
        facts: { aboutIds: ["player-1"] },
      })],
      worldTick: 10,
    }, view());
    expect(plan.inserts).toContainEqual(expect.objectContaining({
      kind: "relation",
      epistemic: "reported-claim",
    }));
  });

  it("preserves eviction status when a relation bucket is full", () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.relationModifiersPerTarget = 1;
    const memory = createLedgerPort(config, ids);
    const existing = memoryRow({
      memoryId: "mem-000000000209",
      kind: "relation",
      tier: "long",
      validFromTick: 1,
      salience: 0.125,
      data: {
        relationTargetId: "player-1",
        dimension: "trust",
        delta: 1,
        cause: "agreement",
        modifiedAtTick: 1,
        halfLifeTicks: 120,
      },
    });
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 1,
      observations: [observation({
        id: "obs-000000000063",
        seq: 2,
        tick: 12,
        eventType: "InformationShared",
        facts: { fromId: "player-1", evidenceId: "ev-test" },
      })],
      worldTick: 12,
    }, view([existing], 1));
    expect(plan.retires).toContainEqual({
      memoryId: existing.memoryId,
      status: "evicted",
    });
  });

  it("does not double count a reinforced row against capacity", () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.capacity.long = 1;
    const memory = createLedgerPort(config, ids);
    const record = memoryRow({
      memoryId: "mem-000000000204",
      kind: "episodic",
      tier: "long",
      validFromTick: 1,
      salience: 0.5,
      data: { eventType: "WorldFactRecorded" },
    });
    const source = observation({
      id: "obs-000000000042",
      seq: 1,
      tick: 1,
      eventType: "WorldFactRecorded",
    });
    const plan = memory.recordUse({
      scope,
      baseRevision: 1,
      turnId: "turn-000000000001",
      citedMemoryIds: [record.memoryId],
      noteworthy: [],
      inputObservations: [source],
      worldTick: 2,
    }, view([record], 1));
    expect(plan.retires).toEqual([{
      memoryId: record.memoryId,
      status: "superseded",
    }]);
  });

  it("counts replacement versions and promotions together against capacity", async () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.capacity.long = 1;
    const memory = createLedgerPort(config, ids);
    const records = [
      memoryRow({
        memoryId: "mem-000000000210",
        kind: "episodic",
        tier: "long",
        validFromTick: 0,
        salience: 0.5,
        data: { eventType: "WorldFactRecorded" },
      }),
      memoryRow({
        memoryId: "mem-000000000211",
        kind: "episodic",
        tier: "short",
        validFromTick: 0,
        salience: 0.5,
        data: { eventType: "AgreementActivated" },
        recallCount: 2,
      }),
    ];
    const plan = await memory.runMaintenance({
      moduleId: "agent.memory.ledger",
      trigger: "day-passed",
      dueTick: 10,
      baseRevision: 1,
      observationSeqThrough: 2,
      day: 1,
      needsModel: false,
    }, view(records, 1));
    expect(plan.inserts.filter((row) => row.tier === "long" && row.status === "active")).toHaveLength(1);
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

  it("uses an earlier invitation observation to date an accepted task promise", () => {
    const memory = port();
    const issued = {
      ...observation({
        id: "obs-000000000031",
        seq: 1,
        tick: 10,
        eventType: "TaskInvitationIssued",
        facts: {
          invitationId: "inv-000000000001",
          taskId: "task-000000000001",
          inviteeId: "human-independent",
          taskType: "escort",
          departTick: 20,
        },
        summary: "收到护送邀请",
        epistemic: "reported",
      }),
      releasePolicyId: "private:sec-invitation",
    };
    const first = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [issued],
      worldTick: 10,
    }, view());
    const accepted = {
      ...observation({
        id: "obs-000000000032",
        seq: 2,
        tick: 11,
        eventType: "TaskInvitationAnswered",
        facts: {
          invitationId: "inv-000000000001",
          taskId: "task-000000000001",
          inviteeId: "human-independent",
          response: "accept",
          reasonCode: null,
        },
        summary: "接受护送邀请",
      }),
      releasePolicyId: "public",
    };
    const second = memory.prepareIngest({
      scope,
      baseRevision: 1,
      observations: [accepted],
      worldTick: 11,
    }, view(asViews(first), 1));
    const promise = second.inserts.find((row) => row.kind === "prospective");
    expect(promise).toMatchObject({
      kind: "prospective",
      releasePolicyId: "private:sec-invitation",
      content: expect.objectContaining({
        data: expect.objectContaining({
          sourceKind: "task",
          taskId: "task-000000000001",
          dueTick: 20,
        }),
      }),
      epistemic: "reported-claim",
    });
    expect(promise?.sourceObservationIds).toEqual([
      "obs-000000000031",
      "obs-000000000032",
    ]);
  });

  it("does not use an invitation observed after the acceptance sequence", () => {
    const memory = port();
    const earlier = observation({
      id: "obs-000000000033",
      seq: 1,
      tick: 10,
      eventType: "TaskInvitationIssued",
      facts: {
        invitationId: "inv-000000000001",
        taskId: "task-000000000001",
        inviteeId: "human-independent",
        taskType: "escort",
        departTick: 20,
      },
    });
    const first = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [earlier],
      worldTick: 10,
    }, view());
    const accepted = observation({
      id: "obs-000000000034",
      seq: 2,
      tick: 11,
      eventType: "TaskInvitationAnswered",
      facts: {
        invitationId: "inv-000000000001",
        taskId: "task-000000000001",
        inviteeId: "human-independent",
        response: "accept",
        reasonCode: null,
      },
    });
    const later = observation({
      id: "obs-000000000035",
      seq: 3,
      tick: 11,
      eventType: "TaskInvitationIssued",
      facts: {
        invitationId: "inv-000000000002",
        taskId: "task-000000000001",
        inviteeId: "human-independent",
        taskType: "escort",
        departTick: 99,
      },
    });
    const second = memory.prepareIngest({
      scope,
      baseRevision: 1,
      observations: [accepted, later],
      worldTick: 11,
    }, view(asViews(first), 1));
    expect(second.inserts.find((row) => row.kind === "prospective")?.content.data)
      .toMatchObject({ dueTick: 20 });
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
    const records = asViews(ingested);
    const cited = records[0];
    if (cited === undefined) throw new Error("expected an ingest record for citation");
    const used = memory.recordUse({
      scope,
      baseRevision: 1,
      turnId: "turn-000000000001",
      citedMemoryIds: [cited.memoryId],
      noteworthy: [],
      inputObservations: events,
      worldTick: 12,
    }, view(records, 1));
    expect(used.inserts.map((row) => row.memoryId)).toEqual([cited.memoryId]);
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

  it("keeps an aggregate private when a later public observation joins it", () => {
    const memory = port();
    const existing = memoryRow({
      memoryId: "mem-000000000301",
      kind: "episodic",
      tier: "short",
      validFromTick: 1,
      salience: 0.2,
      releasePolicyId: "private:sec-test",
      epistemic: "reported-claim",
      data: {
        aggregateKey: "aggregate:1:RumorSpread",
        aggregate: true,
        eventType: "RumorSpread",
        day: 1,
        count: 1,
        salience: 0.2,
      },
    });
    const publicRumor = {
      ...observation({
        id: "obs-000000000051",
        seq: 2,
        tick: 2,
        eventType: "RumorSpread",
        channel: "broadcast",
      }),
      releasePolicyId: "public",
    };
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 1,
      observations: [publicRumor],
      worldTick: 2,
    }, view([existing], 1));
    expect(plan.inserts).toContainEqual(expect.objectContaining({
      memoryId: existing.memoryId,
      epistemic: "reported-claim",
      releasePolicyId: "private:sec-test",
    }));
  });

  it("honors disabled relation and prospective inputs", () => {
    const config = ledgerConfigSchema.parse(memoryLedgerModuleDefinition.defaults);
    config.relationInput = "disabled";
    config.prospectiveInput = "disabled";
    const memory = createLedgerPort(config, ids);
    const plan = memory.prepareIngest({
      scope,
      baseRevision: 0,
      observations: [observation({
        id: "obs-000000000052",
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
            amount: 1,
            fromStockpileId: "sp-grayharbor",
            toStockpileId: "sp-pass",
            byTick: 20,
          }],
        },
      })],
      worldTick: 10,
    }, view());
    expect(plan.inserts.some((row) => row.kind === "relation")).toBe(false);
    expect(plan.inserts.some((row) => row.kind === "prospective")).toBe(false);
    expect(plan.inserts.some((row) => row.kind === "episodic")).toBe(true);
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
    const privateSource = {
      ...observation({
        id: "obs-000000000009",
        seq: 2,
        tick: 12,
        eventType: "InformationShared",
        summary: "一段私有补充",
      }),
      releasePolicyId: "private:sec-test",
    };
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
        sourceRefs: [source.observationId, privateSource.observationId],
      }],
      inputObservations: [source, privateSource],
      worldTick: 12,
    }, view());
    expect(valid.inserts).toHaveLength(1);
    expect(valid.inserts[0]?.epistemic).toBe("reported-claim");
    expect(valid.inserts[0]?.releasePolicyId).toBe("private:sec-test");
    expect(valid.inserts[0]?.sourceTurnId).toBe("turn-000000000001");

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
  readonly tags?: readonly string[];
  readonly releasePolicyId?: string;
  readonly epistemic?: MemoryRecordView["epistemic"];
  readonly sourceObservationIds?: readonly string[];
  readonly recallCount?: number;
}): MemoryRecordView {
  return {
    memoryId: input.memoryId,
    rowVersion: 1,
    kind: input.kind,
    tier: input.tier,
    status: "active",
    epistemic: input.epistemic ?? "verified-event",
    releasePolicyId: input.releasePolicyId ?? "parties:human-independent,player-1",
    validFromTick: input.validFromTick,
    validUntilTick: null,
    strength: input.salience,
    salience: input.salience,
    recallCount: input.recallCount ?? 0,
    lastReinforcedTick: input.validFromTick,
    tags: [...(input.tags ?? ["test"])],
    sourceObservationIds: [...(input.sourceObservationIds ?? ["obs-000000000001"])],
    content: {
      summaryZh: "测试记录",
      counterpartIds: ["player-1"],
      data: input.data,
    },
  };
}

function dataObject(value: Json): Readonly<Record<string, Json>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}
