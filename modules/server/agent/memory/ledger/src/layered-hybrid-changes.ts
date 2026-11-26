/**
 * 核心职责：校验每日模型返回的看法、关注与意向，并生成受容量约束的记忆计划。
 * 交互契约：只接收冻结 revision、已验证证据与注入 ID，不调用存储或模型。
 * 约束与禁忌：未知证据、未知主体和非法 belief 操作必须丢弃并留下可审计原因。
 */
import type { IdPrefix, MemoryChangePlan, MaintenanceTask } from "@world-prism/contracts";
import type { MemoryRecordView, RevisionView } from "@world-prism/module-sdk";
import type { DailyReviewOutput } from "./layered-hybrid-model";
import type { LayeredHybridConfig } from "./layered-hybrid-config";
import { compareStrings, mergeReleasePolicies } from "./ledger-model";

type Ids = (prefix: IdPrefix) => string;

export interface DailyReviewChanges {
  readonly inserts: MemoryChangePlan["inserts"];
  readonly retires: MemoryChangePlan["retires"];
  readonly discarded: readonly { readonly source: string; readonly reason: string }[];
}

interface DailyReviewInput {
  readonly response: DailyReviewOutput;
  readonly task: MaintenanceTask;
  readonly view: RevisionView;
  readonly today: readonly MemoryRecordView[];
  readonly beliefs: readonly MemoryRecordView[];
  readonly ids: Ids;
  readonly config: LayeredHybridConfig;
}

export function applyDailyReview(input: DailyReviewInput): DailyReviewChanges {
  const changes = [beliefChanges(input), concernChanges(input), intentChanges(input)];
  return limitBeliefs(input, {
    inserts: changes.flatMap((change) => change.inserts),
    retires: dedupeRetires(changes.flatMap((change) => change.retires)),
    discarded: changes.flatMap((change) => change.discarded),
  });
}

function beliefChanges(input: DailyReviewInput): DailyReviewChanges {
  const { response, task, view, today, beliefs, ids } = input;
  const inserts: MemoryChangePlan["inserts"] = [];
  const retires: MemoryChangePlan["retires"] = [];
  const discarded: { source: string; reason: string }[] = [];
  const evidenceById = new Map([...today, ...beliefs].map((record) => [record.memoryId, record]));
  const handledBeliefs = new Set<string>();
  const beliefById = new Map(beliefs.map((record) => [record.memoryId, record]));
  for (const [index, op] of response.beliefOps.entries()) {
    const evidence = op.evidenceIds.map((id) => evidenceById.get(id))
      .filter((record): record is MemoryRecordView => record !== undefined && record.status === "active");
    if (op.op === "keep") continue;
    const existing = op.op === "add" || op.beliefId === null ? undefined : beliefById.get(op.beliefId);
    const reason = beliefDiscardReason(op, evidence, existing, view);
    if (reason !== null) {
      discarded.push({ source: `belief-${index}`, reason });
      continue;
    }
    if (existing !== undefined && op.op !== "add") {
      if (handledBeliefs.has(existing.memoryId)) {
        discarded.push({ source: `belief-${index}`, reason: "duplicate-belief-operation" });
        continue;
      }
      handledBeliefs.add(existing.memoryId);
      retires.push({ memoryId: existing.memoryId, status: "superseded" });
    }
    const memoryId = op.op === "update" && existing !== undefined
      ? existing.memoryId
      : ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"];
    const sources = existing === undefined ? evidence : [...evidence, existing];
    inserts.push({
      memoryId, kind: "belief", tier: "long", status: "active", epistemic: "inference",
      releasePolicyId: mergeReleasePolicies(sources.map((record) => record.releasePolicyId)),
      validFromTick: task.dueTick, validUntilTick: null, strength: op.confidence, salience: op.confidence,
      recallCount: existing?.recallCount ?? 0, lastReinforcedTick: task.dueTick,
      tags: ["belief", "daily-review"],
      sourceObservationIds: [...new Set(sources.flatMap((record) => record.sourceObservationIds))].sort(compareStrings),
      content: {
        summaryZh: op.statement,
        counterpartIds: [...new Set(sources.flatMap((record) => record.content.counterpartIds))].sort(compareStrings),
        data: { belief: true, confidence: op.confidence, evidenceIds: [...op.evidenceIds], reviewedThroughSeq: task.observationSeqThrough },
      },
    });
  }
  return { inserts, retires, discarded };
}

function beliefDiscardReason(
  op: DailyReviewOutput["beliefOps"][number],
  evidence: readonly MemoryRecordView[],
  existing: MemoryRecordView | undefined,
  view: RevisionView,
): string | null {
  if (evidence.length !== op.evidenceIds.length) return "evidence-not-visible";
  if (!namesKnown(op.statement, view.identity.knownPrincipalNames ?? {})) return "unknown-principal";
  if (op.op !== "add" && existing === undefined) return "belief-not-visible";
  return null;
}

function concernChanges(input: DailyReviewInput): DailyReviewChanges {
  const { response, task, view, today, ids } = input;
  const inserts: MemoryChangePlan["inserts"] = [];
  const retires: MemoryChangePlan["retires"] = [];
  const discarded: { source: string; reason: string }[] = [];
  if (response.currentConcerns !== null && !namesKnown(response.currentConcerns, view.identity.knownPrincipalNames ?? {})) {
    discarded.push({ source: "concerns", reason: "unknown-principal" });
  } else if (response.currentConcerns !== null && today.length === 0) {
    discarded.push({ source: "concerns", reason: "evidence-not-visible" });
  } else if (response.currentConcerns !== null) {
    for (const record of view.records.filter((record) => record.status === "active" && record.kind === "core")) {
      retires.push({ memoryId: record.memoryId, status: "superseded" });
    }
    inserts.push({
      memoryId: ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"],
      kind: "core", tier: "core", status: "active", epistemic: "inference", releasePolicyId: `private:${view.scope.agentId}`,
      validFromTick: task.dueTick, validUntilTick: null, strength: 1, salience: 1, recallCount: 0,
      lastReinforcedTick: task.dueTick, tags: ["core", "concerns"],
      sourceObservationIds: [...new Set(today.flatMap((record) => record.sourceObservationIds))].sort(compareStrings),
      content: { summaryZh: response.currentConcerns, counterpartIds: [], data: { core: true, currentConcerns: response.currentConcerns } },
    });
  }
  return { inserts, retires, discarded };
}

function intentChanges(input: DailyReviewInput): DailyReviewChanges {
  const { response, task, view, today, beliefs, ids } = input;
  const inserts: MemoryChangePlan["inserts"] = [];
  const retires: MemoryChangePlan["retires"] = [];
  const discarded: { source: string; reason: string }[] = [];
  const evidenceById = new Map([...today, ...beliefs].map((record) => [record.memoryId, record]));
  for (const [index, intent] of response.intents.entries()) {
    const reasons = intent.reasonIds.map((id) => evidenceById.get(id))
      .filter((record): record is MemoryRecordView => record !== undefined && record.status === "active");
    if (reasons.length === 0 || reasons.length !== intent.reasonIds.length) {
      discarded.push({ source: `intent-${index}`, reason: "reason-not-visible" });
      continue;
    }
    const knownTargets = new Set([
      ...Object.keys(view.identity.knownPrincipalNames ?? {}),
      view.scope.agentId,
      ...view.identity.initialRelations.map((relation) => relation.targetId),
      ...view.records.flatMap((record) => record.content.counterpartIds),
    ]);
    if (!knownTargets.has(intent.targetId)) {
      discarded.push({ source: `intent-${index}`, reason: "target-not-known" });
      continue;
    }
    inserts.push({
      memoryId: ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"],
      kind: "episodic", tier: "short", status: "active", epistemic: "inference",
      releasePolicyId: mergeReleasePolicies(reasons.map((record) => record.releasePolicyId)),
      validFromTick: task.dueTick, validUntilTick: null, strength: 0.4, salience: 0.4, recallCount: 0,
      lastReinforcedTick: task.dueTick, tags: ["intent", intent.kind],
      sourceObservationIds: [...new Set(reasons.flatMap((record) => record.sourceObservationIds))].sort(compareStrings),
      content: {
        summaryZh: `意向：${intent.kind} → ${intent.targetId}`,
        counterpartIds: [intent.targetId],
        data: { intent: true, intentKind: intent.kind, targetId: intent.targetId, reasonIds: [...intent.reasonIds], dueTick: intentWakeupTick(task.dueTick) },
      },
    });
  }
  return { inserts, retires, discarded };
}

function limitBeliefs(input: DailyReviewInput, changes: DailyReviewChanges): DailyReviewChanges {
  const { view, config } = input;
  const inserts = [...changes.inserts];
  const retires = [...changes.retires];
  const discarded = changes.discarded;
  const replaceIds = new Set([...inserts.map((record) => record.memoryId), ...retires.map((record) => record.memoryId)]);
  const candidates = [
    ...view.records.filter((record) => record.status === "active" && record.kind === "belief" && !replaceIds.has(record.memoryId)),
    ...inserts.filter((record) => record.kind === "belief"),
  ].sort((left, right) => left.recallCount - right.recallCount || left.validFromTick - right.validFromTick || left.memoryId.localeCompare(right.memoryId));
  const evicted = new Set(candidates.slice(0, Math.max(0, candidates.length - config.capacity.beliefs)).map((record) => record.memoryId));
  for (const record of view.records.filter((record) => record.kind === "belief" && evicted.has(record.memoryId))) {
    retires.push({ memoryId: record.memoryId, status: "evicted" });
  }
  for (let index = inserts.length - 1; index >= 0; index -= 1) {
    const record = inserts[index];
    if (record !== undefined && evicted.has(record.memoryId)) inserts.splice(index, 1);
  }
  return { inserts, retires: dedupeRetires(retires), discarded };
}

function namesKnown(statement: string, names: Readonly<Record<string, string>>): boolean {
  const referencedIds = statement.match(/\b(?:player|npc|human|species)-[a-z0-9-]+\b/g) ?? [];
  return referencedIds.every((id) => Object.prototype.hasOwnProperty.call(names, id));
}

function intentWakeupTick(dueTick: number): number {
  const morning = Math.floor(dueTick / 24) * 24 + 8;
  return morning > dueTick ? morning : morning + 24;
}

function dedupeRetires(retires: MemoryChangePlan["retires"]): MemoryChangePlan["retires"] {
  return [...new Map(retires.map((retire) => [retire.memoryId, retire])).values()];
}