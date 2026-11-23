/**
 * 验证观察流反思与分层混合记忆的整理、失败保留和核心块行为。
 * 依赖冻结 revision 夹具与显式模型结果，不访问网络或真实 SQLite。
 * 禁止把模型输出直接写成世界事实或绕过内存端口校验。
 */
import { describe, expect, it } from "vitest";
import type {
  AgentMemoryQuery,
  AgentObservation,
  AgentModelCallResult,
  Json,
  MemoryChangePlan,
} from "@ai-npc/contracts";
import type {
  MemoryAgentIdentity,
  MemoryRecordView,
  RevisionView,
  ScopedModelPort,
} from "@ai-npc/module-sdk";
import {
  layeredHybridConfigSchema,
  layeredHybridDefaults,
  streamReflectionConfigSchema,
  streamReflectionDefaults,
} from "../src/definition";
import { createLayeredHybridPort } from "../src/layered-hybrid-port";
import { createStreamReflectionPort } from "../src/stream-reflection-port";

const scope = {
  worldId: "wld-000000000001",
  branchId: "br-000000000001",
  agentId: "human-independent",
} as const;
const identity: MemoryAgentIdentity = {
  factionId: "human-independent",
  values: ["重约", "怕封锁"],
  initialRelations: [{ targetId: "player-1", trust: 0 }],
  personalityKeywords: { agreement: ["约"], rescue: ["救"], resource: ["供给"], road: ["封锁"], evidence: ["证据"] },
  name: "岑雁",
  role: "砾火同盟党魁",
  goals: ["恢复守备通信"],
  knownPrincipalNames: { "player-1": "玩家", "human-independent": "岑雁" },
};

let sequence = 0;
function ids(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence.toString(32).padStart(12, "0")}`;
}

function observation(input: {
  readonly seq: number;
  readonly tick?: number;
  readonly eventType?: string;
  readonly summary?: string;
  readonly releasePolicyId?: string;
}): AgentObservation {
  const tick = input.tick ?? 10;
  return {
    observationId: `obs-${String(input.seq).padStart(12, "0")}` as AgentObservation["observationId"],
    scope,
    observationSeq: input.seq,
    sourceEventIds: [`evt-${String(input.seq).padStart(12, "0")}` as AgentObservation["sourceEventIds"][number]],
    sourceObservationIds: [],
    occurredAtTick: tick,
    sensedAtTick: tick,
    knownAtTick: tick,
    channel: "party",
    epistemic: "witnessed",
    confidence: 1,
    releasePolicyId: input.releasePolicyId ?? "parties:human-independent,player-1",
    content: {
      eventType: input.eventType ?? "AgreementBreached",
      summaryZh: input.summary ?? "承诺没有兑现",
      subjectIds: ["player-1"],
      nodeId: null,
      refs: {},
      facts: { obligorId: "player-1" },
      claim: null,
      detail: "full",
    },
  };
}

function view(records: readonly MemoryRecordView[] = [], revision = 0): RevisionView {
  return { scope, revision, identity, records };
}

function views(plan: MemoryChangePlan): MemoryRecordView[] {
  return plan.inserts.map((row) => ({
    ...row,
    rowVersion: 1,
    tags: [...row.tags],
    sourceObservationIds: [...row.sourceObservationIds],
    content: { ...row.content, counterpartIds: [...row.content.counterpartIds] },
  }));
}

function response(json: Json): AgentModelCallResult {
  return {
    response: {
      finishReason: "stop", text: null, json, jsonError: null, toolCalls: [], providerReplay: null,
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, estimated: false },
      servedModel: "fixture", providerRequestId: null, fallbackUsed: false,
      wire: { requestBody: {}, responseBody: {} },
    },
    attempts: [],
  };
}

function model(result: AgentModelCallResult | Error): ScopedModelPort {
  return {
    scope: { runId: "run-000000000001", agentId: scope.agentId, purpose: "memory-maintenance" },
    async call() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function query(revision: number, tick: number): AgentMemoryQuery {
  return {
    scope,
    revision,
    frontier: {
      worldSeq: 10, worldTick: tick, observationSeq: 2, memoryRevision: revision,
      perceptionRevision: 1, knowledgeGrantRevision: 1, conversationCursor: null,
    },
    counterpartIds: ["player-1"], queryTags: ["agreement", "breach"], queryText: "承诺",
    nodeId: null, purpose: "decision", audience: [scope.agentId], maxItems: 8, maxTokens: 1000,
  };
}
describe("memory comparison variants", () => {
  it.each(["stream", "hybrid"])("preserves scope rejection for the %s provider", (kind) => {
    const port = kind === "stream"
      ? createStreamReflectionPort(streamReflectionConfigSchema.parse(streamReflectionDefaults), ids)
      : createLayeredHybridPort(layeredHybridConfigSchema.parse(layeredHybridDefaults), ids, null);
    const foreign = { ...scope, agentId: "human-pacifist" };
    expect(() => port.prepareIngest({ scope: foreign, baseRevision: 0, observations: [], worldTick: 10 }, view())).toThrow("memory scope does not match the frozen revision");
    expect(() => port.retrieve({ ...query(0, 10), scope: foreign }, view())).toThrow("memory scope does not match the frozen revision");
    expect(() => port.planMaintenance({ scope: foreign, revision: 0, worldTick: 10, observationSeqThrough: 0, trigger: "day-passed" }, view())).toThrow("memory scope does not match the frozen revision");
  });
  it("M2 evicts low-importance pending rows and oversized batches", () => {
    const port = createStreamReflectionPort(streamReflectionConfigSchema.parse({ ...streamReflectionDefaults, capacity: { stream: 2, reflections: 1 } }), ids);
    const high = port.prepareIngest({ scope, baseRevision: 0, observations: [observation({ seq: 1 }), observation({ seq: 2 })], worldTick: 10 }, view());
    const low = port.prepareIngest({ scope, baseRevision: 1, observations: [observation({ seq: 3, eventType: "TickAdvanced" })], worldTick: 10 }, view(views(high), 1));
    expect(low.inserts).toEqual([]);
    expect(low.retires).toEqual([]);
    const oversized = port.prepareIngest({ scope, baseRevision: 0, observations: [1, 2, 3, 4].map((seq) => observation({ seq })), worldTick: 10 }, view());
    expect(oversized.inserts).toHaveLength(2);
  });

  it("M2 rejects evidence outside the exact model window", async () => {
    const port = createStreamReflectionPort(streamReflectionConfigSchema.parse({ ...streamReflectionDefaults, reflection: { ...streamReflectionDefaults.reflection, recentWindow: 2 } }), ids);
    const ingest = port.prepareIngest({ scope, baseRevision: 0, observations: [1, 2, 3].map((seq) => observation({ seq })), worldTick: 10 }, view());
    const records = views(ingest);
    const task = { moduleId: "agent.memory.stream-reflection", trigger: "importance" as const, dueTick: 11, baseRevision: 1, observationSeqThrough: 3, day: null, needsModel: true };
    const excluded = await port.runMaintenance(task, view(records, 1), model(response({ reflections: [{ statement: "outside evidence", evidenceIds: [records[0]?.memoryId ?? "", records[1]?.memoryId ?? ""], confidence: 0.7 }] })));
    expect(excluded.inserts).toEqual([]);
    expect(excluded.maintenanceResult?.discarded).toEqual([{ source: "reflection-0", reason: "evidence-not-visible" }]);
    const accepted = await port.runMaintenance(task, view(records, 1), model(response({ reflections: [{ statement: "visible evidence", evidenceIds: records.slice(1).map((record) => record.memoryId), confidence: 0.7 }] })));
    expect(accepted.inserts).toHaveLength(1);
  });

  it("M3 retires updated beliefs once and audits duplicate operations once", async () => {
    const port = createLayeredHybridPort(layeredHybridConfigSchema.parse(layeredHybridDefaults), ids, null);
    const ingest = port.prepareIngest({ scope, baseRevision: 0, observations: [observation({ seq: 1, tick: 24 })], worldTick: 24 }, view());
    const evidence = views(ingest).find((row) => row.kind === "episodic");
    if (evidence === undefined) throw new Error("missing evidence");
    const belief: MemoryRecordView = { ...evidence, memoryId: "mem-000000000099", kind: "belief", tier: "long", salience: 0.1 };
    const before = view([...views(ingest), belief], 1);
    const task = port.planMaintenance({ scope, revision: 1, worldTick: 24, observationSeqThrough: 1, trigger: "day-passed" }, before);
    if (task === null) throw new Error("missing daily task");
    const update = { op: "update", beliefId: belief.memoryId, statement: "updated belief", evidenceIds: [evidence.memoryId], confidence: 0.7 };
    const plan = await port.runMaintenance(task, before, model(response({ beliefOps: [update, update], currentConcerns: "player-9 is unknown", intents: [] })));
    expect(plan.inserts.filter((row) => row.memoryId === belief.memoryId)).toHaveLength(1);
    expect(plan.retires.filter((row) => row.memoryId === belief.memoryId)).toEqual([{ memoryId: belief.memoryId, status: "superseded" }]);
    expect(plan.maintenanceResult?.discarded).toEqual([
      { source: "belief-1", reason: "duplicate-belief-operation" },
      { source: "concerns", reason: "unknown-principal" },
    ]);
    expect(plan.inserts.some((row) => row.kind === "core")).toBe(false);
  });

  it("M3 keeps belief capacity separate from ledger long capacity", async () => {
    const config = layeredHybridConfigSchema.parse({ ...layeredHybridDefaults, capacity: { ...layeredHybridDefaults.capacity, long: 1, beliefs: 3 } });
    const port = createLayeredHybridPort(config, ids, null);
    const ingest = createLayeredHybridPort(layeredHybridConfigSchema.parse(layeredHybridDefaults), ids, null).prepareIngest({ scope, baseRevision: 0, observations: [observation({ seq: 1 })], worldTick: 10 }, view());
    const sample = views(ingest).find((row) => row.kind === "episodic");
    if (sample === undefined) throw new Error("missing sample");
    const beliefs = ["mem-000000000097", "mem-000000000098"].map((memoryId) => ({ ...sample, memoryId, kind: "belief" as const, tier: "long" as const, salience: 0.1 }));
    const before = view([...views(ingest), ...beliefs], 1);
    const plan = await port.runMaintenance({ moduleId: "agent.memory.layered-hybrid", trigger: "day-passed", dueTick: 24, baseRevision: 1, observationSeqThrough: 1, day: 2, needsModel: false }, before, null);
    expect(plan.retires.some((row) => beliefs.some((belief) => belief.memoryId === row.memoryId))).toBe(false);
  });

  it("M3 disables intent wakeups and rejects intents without reasons", async () => {
    const port = createLayeredHybridPort(layeredHybridConfigSchema.parse({ ...layeredHybridDefaults, wakeups: "disabled" }), ids, null);
    const ingest = port.prepareIngest({ scope, baseRevision: 0, observations: [observation({ seq: 1 })], worldTick: 10 }, view());
    const intent = { ...views(ingest)[0], kind: "episodic", content: { summaryZh: "intent", counterpartIds: [], data: { intent: true, dueTick: 8, targetId: "player-1" } } } as MemoryRecordView;
    expect(port.proposeWakeups({ scope, revision: 1, worldTick: 32 }, view([intent], 1))).toEqual([]);
    const plan = await port.runMaintenance({ moduleId: "agent.memory.layered-hybrid", trigger: "day-passed", dueTick: 24, baseRevision: 1, observationSeqThrough: 1, day: 2, needsModel: true }, view(views(ingest), 1), model(response({ beliefOps: [], currentConcerns: null, intents: [{ kind: "remind", targetId: "player-1", reasonIds: [] }] })));
    expect(plan.maintenanceResult?.status).toBe("partial");
    expect(plan.inserts.some((row) => row.tags.includes("intent"))).toBe(false);
  });
  it("M2 queues reflection only after the importance threshold", async () => {
    const port = createStreamReflectionPort(streamReflectionConfigSchema.parse(streamReflectionDefaults), ids);
    const observations = [observation({ seq: 1 }), observation({ seq: 2, summary: "第二次违约" })];
    const ingest = port.prepareIngest({ scope, baseRevision: 0, observations, worldTick: 10 }, view());
    const afterIngest = view(views(ingest), 1);
    const task = port.planMaintenance({
      scope, revision: 1, worldTick: 10, observationSeqThrough: 2, trigger: "importance",
    }, afterIngest);
    expect(task).toMatchObject({ trigger: "importance", dueTick: 11, needsModel: true });
    const evidence = ingest.inserts.filter((row) => row.kind !== "relation").map((row) => row.memoryId).slice(0, 2);
    const plan = await port.runMaintenance({
      moduleId: "agent.memory.stream-reflection", trigger: "importance", dueTick: 11,
      baseRevision: 1, observationSeqThrough: 2, day: null, needsModel: true,
    }, afterIngest, model(response({ reflections: [{ statement: "玩家会再次失约", evidenceIds: evidence, confidence: 0.8 }] })));
    expect(plan.inserts.some((row) => row.kind === "belief")).toBe(true);
    expect(plan.maintenanceResult).toMatchObject({ status: "completed" });
  });

  it("M2 marks an unavailable maintenance model as partial", async () => {
    const port = createStreamReflectionPort(streamReflectionConfigSchema.parse(streamReflectionDefaults), ids);
    const plan = await port.runMaintenance({
      moduleId: "agent.memory.stream-reflection", trigger: "importance", dueTick: 11,
      baseRevision: 1, observationSeqThrough: 2, day: null, needsModel: true,
    }, view(), null);
    expect(plan).toMatchObject({ derivedThroughSeq: null, maintenanceResult: { status: "partial" } });
  });

  it("M3 marks high-salience public observations for branch storage", () => {
    const config = layeredHybridConfigSchema.parse(layeredHybridDefaults);
    const port = createLayeredHybridPort(config, ids, null);
    const plan = port.prepareIngest({ scope, baseRevision: 0, observations: [observation({ seq: 1, eventType: "RelayDown", releasePolicyId: "public" })], worldTick: 10 }, view());
    expect(plan.inserts.some((row) => row.kind === "public" && row.branchPublic === true)).toBe(true);
  });

  it("M3 preserves rule changes when the daily model fails", async () => {
    const config = layeredHybridConfigSchema.parse(layeredHybridDefaults);
    const port = createLayeredHybridPort(config, ids, () => () => 0.5);
    const ingest = port.prepareIngest({
      scope, baseRevision: 0, observations: [observation({ seq: 1 }), observation({ seq: 2 })], worldTick: 20,
    }, view());
    const afterIngest = view(views(ingest), 1);
    const task = port.planMaintenance({
      scope, revision: 1, worldTick: 20, observationSeqThrough: 2, trigger: "day-passed",
    }, afterIngest);
    if (task === null) throw new Error("expected a layered-hybrid maintenance task");
    const plan = await port.runMaintenance(task, afterIngest, model(new Error("provider timeout")));
    expect(plan.inserts.length).toBeGreaterThan(0);
    expect(plan).toMatchObject({ derivedThroughSeq: null, maintenanceResult: { status: "partial" } });
  });

  it("M3 persists model beliefs and a bounded core block", async () => {
    const config = layeredHybridConfigSchema.parse(layeredHybridDefaults);
    const port = createLayeredHybridPort(config, ids, () => () => 0.5);
    const ingest = port.prepareIngest({ scope, baseRevision: 0, observations: [observation({ seq: 1 })], worldTick: 24 }, view());
    const afterIngest = view(views(ingest), 1);
    const task = port.planMaintenance({
      scope, revision: 1, worldTick: 24, observationSeqThrough: 1, trigger: "day-passed",
    }, afterIngest);
    if (task === null) throw new Error("expected a layered-hybrid maintenance task");
    const evidence = ingest.inserts.filter((row) => row.kind !== "relation").map((row) => row.memoryId).slice(0, 2);
    const plan = await port.runMaintenance(task, afterIngest, model(response({
      beliefOps: [{ op: "add", beliefId: null, statement: "玩家需要被持续观察", evidenceIds: evidence, confidence: 0.7 }],
      currentConcerns: "先确认玩家是否会兑现承诺",
      intents: [{ kind: "remind", targetId: "player-1", reasonIds: evidence.slice(0, 1) }],
    })));
    expect(plan.inserts.some((row) => row.kind === "belief")).toBe(true);
    expect(plan.inserts.some((row) => row.kind === "core")).toBe(true);
    const afterMaintenance = view(views(plan), 1);
    const bundle = port.retrieve(query(1, 24), afterMaintenance);
    expect(bundle.coreBlock).toContain("先确认玩家是否会兑现承诺");
    expect(Array.from(bundle.coreBlock ?? "").length).toBeLessThanOrEqual(config.coreBlockMaxTokens);
    expect(port.proposeWakeups({ scope, revision: 1, worldTick: 32 }, afterMaintenance))
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: "intent", counterpartId: "player-1" })]));
    expect(port.proposeWakeups({ scope, revision: 1, worldTick: 32 }, afterMaintenance).find((proposal) => proposal.reason === "intent")?.atTick).toBe(32);
  });
});
