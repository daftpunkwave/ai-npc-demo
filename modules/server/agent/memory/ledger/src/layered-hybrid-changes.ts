/**
 * 核心职责：校验每日模型返回的看法、关注与意向，并生成受容量约束的记忆计划。
 * 交互契约：只接收冻结 revision、已验证证据与注入 ID，不调用存储或模型。
 * 约束与禁忌：未知证据、未知主体和非法 belief 操作必须丢弃并留下可审计原因。
 */
import type { IdPrefix, MemoryChangePlan, MaintenanceTask } from "@ai-npc/contracts";
import type { MemoryRecordView, RevisionView } from "@ai-npc/module-sdk";
import type { DailyReviewOutput } from "./layered-hybrid-model";
import type { LayeredHybridConfig } from "./layered-hybrid-config";
import { compareStrings, mergeReleasePolicies } from "./ledger-model";

type Ids = (prefix: IdPrefix) => string;

export interface DailyReviewChanges {
  readonly inserts: MemoryChangePlan["inserts"];
  readonly retires: MemoryChangePlan["retires"];
  readonly discarded: readonly { readonly source: string; readonly reason: string }[];
}

export function applyDailyReview(input: {
  readonly response: DailyReviewOutput;
  readonly task: MaintenanceTask;
  readonly view: RevisionView;
  readonly today: readonly MemoryRecordView[];
  readonly beliefs: readonly MemoryRecordView[];
  readonly ids: Ids;
  readonly config: LayeredHybridConfig;
}): DailyReviewChanges {
  const { response, task, view, today, beliefs, ids, config } = input;
  const inserts: MemoryChangePlan["inserts"] = [];
  const retires: MemoryChangePlan["retires"] = [];
  const discarded: { source: string; reason: string }[] = [];
  const beliefById = new Map(beliefs.map((record) => [record.memoryId, record]));
  for (const [index, op] of response.beliefOps.entries()) {
    const evidence = op.evidenceIds.map((id) => view.records.find((record) => record.memoryId === id))
      .filter((record): record is MemoryRecordView => record !== undefined && record.status === "active");
    if (op.op === "keep") continue;
    if (evidence.length !== op.evidenceIds.length) {
      discarded.push({ source: `belief-${index}`, reason: "evidence-not-visible" });
      continue;
    }
    if (!namesKnown(op.statement, view.identity.knownPrincipalNames ?? {})) {
      discarded.push({ source: `belief-${index}`, reason: "unknown-principal" });
      continue;
    }
    const existing = op.beliefId === null ? undefined : beliefById.get(op.beliefId);
    if (op.op !== "add" && existing === undefined) {
      discarded.push({ source: `belief-${index}`, reason: "belief-not-visible" });
      continue;
    }
    if (op.op === "supersede" && existing !== undefined) {
      retires.push({ memoryId: existing.memoryId, status: "superseded" });
    }
    const memoryId = op.op === "update" && existing !== undefined
      ? existing.memoryId
      : ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"];
    inserts.push({
      memoryId, kind: "belief", tier: "long", status: "active", epistemic: "inference",
      releasePolicyId: mergeReleasePolicies(evidence.map((record) => record.releasePolicyId)),
      validFromTick: task.dueTick, validUntilTick: null, strength: op.confidence, salience: op.confidence,
      recallCount: existing?.recallCount ?? 0, lastReinforcedTick: task.dueTick,
      tags: ["belief", "daily-review"],
      sourceObservationIds: [...new Set(evidence.flatMap((record) => record.sourceObservationIds))].sort(compareStrings),
      content: {
        summaryZh: op.statement,
        counterpartIds: [...new Set(evidence.flatMap((record) => record.content.counterpartIds))].sort(compareStrings),
        data: { belief: true, confidence: op.confidence, evidenceIds: [...op.evidenceIds], reviewedThroughSeq: task.observationSeqThrough },
      },
    });
  }
  if (response.currentConcerns !== null) {
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
  for (const [index, intent] of response.intents.entries()) {
    const reasons = intent.reasonIds.map((id) => view.records.find((record) => record.memoryId === id))
      .filter((record): record is MemoryRecordView => record !== undefined && record.status === "active");
    if (reasons.length !== intent.reasonIds.length) {
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
  const activeBeliefs = view.records.filter((record) => record.status === "active" && record.kind === "belief");
  const replaceIds = new Set([...inserts.map((record) => record.memoryId), ...retires.map((record) => record.memoryId)]);
  const excess = Math.max(0, activeBeliefs.filter((record) => !replaceIds.has(record.memoryId)).length +
    inserts.filter((record) => record.kind === "belief").length - config.capacity.beliefs);
  for (const record of activeBeliefs
    .filter((record) => !replaceIds.has(record.memoryId))
    .sort((left, right) => left.recallCount - right.recallCount || left.validFromTick - right.validFromTick)
    .slice(0, excess)) {
    retires.push({ memoryId: record.memoryId, status: "evicted" });
  }
  return { inserts, retires: dedupeRetires(retires), discarded };
}

function namesKnown(statement: string, names: Readonly<Record<string, string>>): boolean {
  const referencedIds = statement.match(/\b(?:player|npc|human|species)-[a-z0-9-]+\b/g) ?? [];
  return referencedIds.every((id) => Object.prototype.hasOwnProperty.call(names, id));
}

function intentWakeupTick(dueTick: number): number {
  return Math.floor(dueTick / 24) * 24 + 24 + 8;
}

function dedupeRetires(retires: MemoryChangePlan["retires"]): MemoryChangePlan["retires"] {
  return [...new Map(retires.map((retire) => [retire.memoryId, retire])).values()];
}