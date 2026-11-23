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
  it("M2 queues reflection only after the importance threshold", async () => {
    const port = createStreamReflectionPort(streamReflectionConfigSchema.parse(streamReflectionDefaults), ids);
    const observations = [observation({ seq: 1 }), observation({ seq: 2, summary: "第二次违约" })];
    const ingest = port.prepareIngest({ scope, baseRevision: 0, observations, worldTick: 10 }, view());
    const afterIngest = view(views(ingest), 1);
    const task = port.planMaintenance({
      scope, revision: 1, worldTick: 10, observationSeqThrough: 2, trigger: "importance",
    }, afterIngest);
    expect(task).toMatchObject({ trigger: "importance", dueTick: 11, needsModel: true });
    const evidence = ingest.inserts.map((row) => row.memoryId).slice(0, 2);
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
    const ingest = port.prepareIngest({ scope, baseRevision: 0, observations: [observation({ seq: 1 })], worldTick: 20 }, view());
    const afterIngest = view(views(ingest), 1);
    const task = port.planMaintenance({
      scope, revision: 1, worldTick: 20, observationSeqThrough: 1, trigger: "day-passed",
    }, afterIngest);
    if (task === null) throw new Error("expected a layered-hybrid maintenance task");
    const evidence = ingest.inserts.map((row) => row.memoryId).slice(0, 2);
    const plan = await port.runMaintenance(task, afterIngest, model(response({
      beliefOps: [{ op: "add", beliefId: null, statement: "玩家需要被持续观察", evidenceIds: evidence, confidence: 0.7 }],
      currentConcerns: "先确认玩家是否会兑现承诺",
      intents: [{ kind: "remind", targetId: "player-1", reasonIds: evidence.slice(0, 1) }],
    })));
    expect(plan.inserts.some((row) => row.kind === "belief")).toBe(true);
    expect(plan.inserts.some((row) => row.kind === "core")).toBe(true);
    const afterMaintenance = view(views(plan), 1);
    const bundle = port.retrieve(query(1, 20), afterMaintenance);
    expect(bundle.coreBlock).toContain("先确认玩家是否会兑现承诺");
    expect(Array.from(bundle.coreBlock ?? "").length).toBeLessThanOrEqual(config.coreBlockMaxTokens);
    expect(port.proposeWakeups({ scope, revision: 1, worldTick: 32 }, afterMaintenance))
      .toEqual(expect.arrayContaining([expect.objectContaining({ reason: "intent", counterpartId: "player-1" })]));
  });
});