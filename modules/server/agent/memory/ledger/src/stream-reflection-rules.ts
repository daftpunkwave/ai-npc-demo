/**
 * 核心职责：提供 M2 观察流记录、容量淘汰、引用强化与反射材料。
 * 交互契约：只操作冻结 revision、观察与注入 ID，不调用模型或存储。
 * 约束与禁忌：禁止把关系账本、承诺账本或未校验的外部结果写入计划。
 */
import type { AgentObservation, IdPrefix, MemoryChangePlan, MaintenanceTask } from "@world-prism/contracts";
import type { MemoryRecordView, RevisionView } from "@world-prism/module-sdk";
import type { StreamReflectionConfig } from "./definition";
import { baseSalience, dataOf, eventFromObservation, numberValue, tagsFor } from "./ledger-model";
import { importanceOf } from "./stream-reflection-retrieval";
export { importanceOf };

type Ids = (prefix: IdPrefix) => string;
type CapRow = MemoryRecordView | MemoryChangePlan["inserts"][number];

export function streamObservationRow(observation: AgentObservation, view: RevisionView, ids: Ids): MemoryChangePlan["inserts"][number] {
  const event = eventFromObservation(observation, view.scope.agentId);
  const salience = baseSalience(event);
  return {
    memoryId: ids("mem") as MemoryChangePlan["inserts"][number]["memoryId"],
    kind: "episodic", tier: "short", status: "active",
    epistemic: observation.epistemic === "witnessed" ? "verified-event" : observation.epistemic === "reported" ? "reported-claim" : "inference",
    releasePolicyId: observation.releasePolicyId,
    validFromTick: observation.knownAtTick, validUntilTick: null,
    strength: salience, salience, recallCount: 0, lastReinforcedTick: observation.knownAtTick,
    tags: [...tagsFor(event)], sourceObservationIds: [observation.observationId],
    content: {
      summaryZh: event.summaryZh,
      counterpartIds: [...event.counterpartIds],
      data: { stream: true, importance: 1 + Math.round(9 * salience), observationSeq: observation.observationSeq, eventType: event.eventType },
    },
  };
}

export function capStream(plan: MemoryChangePlan, view: RevisionView, config: StreamReflectionConfig): MemoryChangePlan {
  const retiredIds = new Set(plan.retires.map((record) => record.memoryId));
  const activeById = new Map<string, CapRow>(view.records
    .filter((record) => record.status === "active" && record.kind === "episodic" && !retiredIds.has(record.memoryId))
    .map((record) => [record.memoryId, record]));
  for (const record of plan.inserts.filter((record) => record.kind === "episodic")) {
    activeById.set(record.memoryId, record);
  }
  const active = [...activeById.values()];
  const excess = Math.max(0, active.length - config.capacity.stream);
  const evicted = active.sort((left, right) =>
    importanceOf(left) - importanceOf(right) || left.validFromTick - right.validFromTick || left.memoryId.localeCompare(right.memoryId),
  ).slice(0, excess);
  const beliefById = new Map<string, CapRow>(view.records
    .filter((record) => record.status === "active" && record.kind === "belief" && !retiredIds.has(record.memoryId))
    .map((record) => [record.memoryId, record]));
  for (const record of plan.inserts.filter((record) => record.kind === "belief")) {
    beliefById.set(record.memoryId, record);
  }
  const beliefs = [...beliefById.values()];
  const beliefExcess = Math.max(0, beliefs.length - config.capacity.reflections);
  for (const record of beliefs.sort((left, right) =>
    left.recallCount - right.recallCount || left.validFromTick - right.validFromTick || left.memoryId.localeCompare(right.memoryId),
  ).slice(0, beliefExcess)) {
    evicted.push(record);
  }
  const evictedIds = new Set(evicted.map((record) => record.memoryId));
  const existingIds = new Set(view.records.map((record) => record.memoryId));
  return {
    ...plan,
    inserts: plan.inserts.filter((record) => !evictedIds.has(record.memoryId)),
    retires: dedupeRetires([
      ...plan.retires,
      ...evicted.filter((record) => existingIds.has(record.memoryId))
        .map((record) => ({ memoryId: record.memoryId, status: "evicted" as const })),
    ]),
  };
}

export function activeStreamRecords(records: readonly MemoryRecordView[]): readonly MemoryRecordView[] {
  return records.filter((record) => record.status === "active" && record.kind === "episodic" && dataOf(record)["stream"] === true);
}

export function reflectionSourceRecords(records: readonly MemoryRecordView[], task: MaintenanceTask, limit: number): readonly MemoryRecordView[] {
  return records.filter((record) =>
    record.status === "active" && record.kind === "episodic" && dataOf(record)["stream"] === true &&
    (numberValue(dataOf(record)["observationSeq"]) ?? 0) > 0 &&
    (numberValue(dataOf(record)["observationSeq"]) ?? 0) <= task.observationSeqThrough,
  ).sort((left, right) =>
    (numberValue(dataOf(right)["observationSeq"]) ?? 0) - (numberValue(dataOf(left)["observationSeq"]) ?? 0) ||
    left.memoryId.localeCompare(right.memoryId),
  ).slice(0, limit);
}

export function reinforceStreamRow(record: MemoryRecordView, worldTick: number): MemoryChangePlan["inserts"][number] {
  return {
    memoryId: record.memoryId, kind: record.kind, tier: record.tier, status: "active", epistemic: record.epistemic,
    releasePolicyId: record.releasePolicyId, validFromTick: record.validFromTick, validUntilTick: record.validUntilTick,
    strength: record.strength, salience: record.salience, recallCount: record.recallCount + 1,
    lastReinforcedTick: worldTick, tags: [...record.tags], sourceObservationIds: [...record.sourceObservationIds],
    content: { summaryZh: record.content.summaryZh, counterpartIds: [...record.content.counterpartIds], data: record.content.data },
  };
}

export function partialPlan(task: MaintenanceTask, reason: string): MemoryChangePlan {
  return { baseRevision: task.baseRevision, observationSeqThrough: task.observationSeqThrough, inserts: [], retires: [], derivedThroughSeq: null, derivedThroughTick: null, changeKind: "maintenance", maintenanceResult: { status: "partial", failureReason: reason, discarded: [] } };
}

export function namesKnown(statement: string, names: Readonly<Record<string, string>>): boolean {
  const referencedIds = statement.match(/\b(?:player|npc|human|species)-[a-z0-9-]+\b/g) ?? [];
  return referencedIds.every((id) => Object.prototype.hasOwnProperty.call(names, id));
}

export function dedupeRetires(retires: MemoryChangePlan["retires"]): MemoryChangePlan["retires"] {
  return [...new Map(retires.map((retire) => [retire.memoryId, retire])).values()];
}
