/**
 * 执行结构化账本的每日衰减、合并、晋升与关系沉淀。
 * Applies daily ledger decay, consolidation, promotion, and relation sedimentation.
 * Depends on a frozen revision view and deterministic memory-plan contracts.
 * Must not run model calls or publish state outside the host actor transaction.
 */
import type { MaintenanceTask, MemoryChangePlan } from "@ai-npc/contracts";
import type {
  MemoryRecordView,
  RevisionView,
} from "@ai-npc/module-sdk";
import type { LedgerConfig } from "./definition";
import {
  type LedgerBuild,
  capacityRetirements,
} from "./ledger-rules";
import {
  type LedgerRow,
  clamp01,
  compareStrings,
  currentStrength,
  dataOf,
  mergeReleasePolicies,
  numberValue,
  objectValue,
  relationModifierWeight,
} from "./ledger-model";

type Ids = (prefix: string) => string;

export function buildMaintenance(
  task: MaintenanceTask,
  view: RevisionView,
  config: LedgerConfig,
  ids: Ids,
): LedgerBuild {
  if (task.needsModel) {
    throw new Error("structured ledger maintenance does not require a model call");
  }
  const inserts: LedgerRow[] = [];
  const retires = new Map<string, MemoryChangePlan["retires"][number]["status"]>();
  const handled = new Set<string>();

  for (const record of relationRecords(view.records)) {
    applyRelationMaintenance(record, task.dueTick, inserts, retires);
    handled.add(record.memoryId);
  }

  for (const record of view.records) {
    if (
      record.status === "active" &&
      record.tier === "short" &&
      record.kind === "episodic" &&
      record.recallCount < 2 &&
      task.dueTick - record.validFromTick >= config.decayBaseTicks.short
    ) {
      retires.set(record.memoryId, "expired");
      handled.add(record.memoryId);
    }
  }

  const shortGroups = groupShortExperiences(view.records, task.dueTick, config, handled);
  for (const group of shortGroups) {
    if (group.length === 0) continue;
    for (const record of group) handled.add(record.memoryId);
    if (group.length > 1) {
      const merged = mergeShortGroup(group, task.dueTick, config, ids);
      inserts.push(merged);
      for (const record of group) retires.set(record.memoryId, "superseded");
      continue;
    }
    const record = group[0];
    if (record === undefined) continue;
    if (task.dueTick - record.validFromTick >= config.decayBaseTicks.short && record.recallCount < 2) {
      retires.set(record.memoryId, "expired");
      continue;
    }
    const nextTier = record.recallCount >= 2 ? "long" as const : record.tier;
    inserts.push(updatedRecord(record, nextTier, task.dueTick, config));
    retires.set(record.memoryId, "superseded");
  }

  for (const record of view.records) {
    if (record.status !== "active" || handled.has(record.memoryId)) continue;
    if (record.tier === "core") continue;
    if (record.kind === "prospective") {
      const dueTick = numberValue(dataOf(record)["dueTick"]);
      if (dueTick !== null && dueTick < task.dueTick) retires.set(record.memoryId, "expired");
      continue;
    }
    const nextTier = record.tier === "long" && record.salience >= 0.9 ? "core" as const : record.tier;
    inserts.push(updatedRecord(record, nextTier, task.dueTick, config));
    retires.set(record.memoryId, "superseded");
  }

  const capped = capacityRetirements(
    {
      inserts,
      retires: [...retires].map(([memoryId, status]) => ({ memoryId, status })),
    },
    view,
    config,
    task.dueTick,
  );
  return capped;
}

function relationRecords(records: readonly MemoryRecordView[]): readonly MemoryRecordView[] {
  return records.filter((record) => record.kind === "relation" && record.status === "active");
}

function applyRelationMaintenance(
  record: MemoryRecordView,
  dueTick: number,
  inserts: LedgerRow[],
  retires: Map<string, MemoryChangePlan["retires"][number]["status"]>,
): void {
  const data = dataOf(record);
  if (data["baseline"] === true) return;
  const weight = relationModifierWeight(record, dueTick);
  if (Math.abs(weight) >= 0.1) return;
  retires.set(record.memoryId, "expired");
  const targetId = data["relationTargetId"];
  const dimension = data["dimension"];
  const cause = data["cause"];
  const delta = numberValue(data["delta"]);
  if (typeof targetId !== "string" || typeof dimension !== "string" || typeof cause !== "string" || delta === null) {
    return;
  }
  inserts.push({
    memoryId: record.memoryId as LedgerRow["memoryId"],
    kind: "relation",
    tier: "long",
    status: "active",
    epistemic: record.epistemic,
    releasePolicyId: record.releasePolicyId,
    validFromTick: record.validFromTick,
    validUntilTick: null,
    strength: Math.min(1, Math.abs(delta * 0.2) / 8),
    salience: Math.min(1, Math.abs(delta * 0.2) / 8),
    recallCount: record.recallCount,
    lastReinforcedTick: dueTick,
    tags: [...record.tags],
    sourceObservationIds: [...record.sourceObservationIds],
    content: {
      summaryZh: `关系累计：${record.content.summaryZh}`,
      counterpartIds: [targetId],
      data: {
        relationTargetId: targetId,
        dimension,
        delta: delta * 0.2,
        cause,
        modifiedAtTick: dueTick,
        halfLifeTicks: Math.max(1, numberValue(data["halfLifeTicks"]) ?? 1),
        baseline: true,
      },
    },
  });
}

function groupShortExperiences(
  records: readonly MemoryRecordView[],
  dueTick: number,
  config: LedgerConfig,
  handled: ReadonlySet<string>,
): readonly (readonly MemoryRecordView[])[] {
  const candidates = records
    .filter((record) =>
      record.status === "active" &&
      record.tier === "short" &&
      record.kind === "episodic" &&
      !handled.has(record.memoryId) &&
      (
        dueTick - record.validFromTick < config.decayBaseTicks.short ||
        record.recallCount >= 2
      ) &&
      dataOf(record)["aggregate"] !== true,
    )
    .sort((left, right) =>
      left.validFromTick - right.validFromTick || left.memoryId.localeCompare(right.memoryId),
    );
  const groups = new Map<string, MemoryRecordView[][]>();
  for (const record of candidates) {
    const data = dataOf(record);
    const eventType = typeof data["eventType"] === "string" ? data["eventType"] : "Unknown";
    const counterpart = record.content.counterpartIds[0] ?? "";
    const key = `${eventType}:${counterpart}`;
    const keyGroups = groups.get(key) ?? [];
    const activeGroup = keyGroups.at(-1);
    const firstTick = activeGroup?.[0]?.validFromTick;
    if (activeGroup === undefined || firstTick === undefined || record.validFromTick - firstTick > 72) {
      keyGroups.push([record]);
    } else {
      activeGroup.push(record);
    }
    groups.set(key, keyGroups);
  }
  return [...groups.values()].flat();
}

function mergeShortGroup(
  records: readonly MemoryRecordView[],
  dueTick: number,
  config: LedgerConfig,
  ids: Ids,
): LedgerRow {
  const first = records[0];
  if (first === undefined) throw new Error("cannot merge an empty ledger group");
  const maxSalience = Math.max(...records.map((record) => record.salience));
  const mergedSalience = clamp01(maxSalience + 0.1 * (records.length - 1));
  const tier = mergedSalience >= config.salienceThresholds.long ? "long" : "short";
  const data = dataOf(first);
  return {
    memoryId: ids("mem") as LedgerRow["memoryId"],
    kind: "episodic",
    tier,
    status: "active",
    epistemic: records.every((record) => record.epistemic === "verified-event")
      ? "verified-event"
      : "reported-claim",
    releasePolicyId: mergeReleasePolicies(records.map((record) => record.releasePolicyId)),
    validFromTick: Math.min(...records.map((record) => record.validFromTick)),
    validUntilTick: null,
    strength: mergedSalience,
    salience: mergedSalience,
    recallCount: records.reduce((sum, record) => sum + record.recallCount, 0),
    lastReinforcedTick: Math.max(...records.map((record) => record.lastReinforcedTick)),
    tags: [...new Set(records.flatMap((record) => record.tags))].sort(compareStrings),
    sourceObservationIds: [...new Set(records.flatMap((record) => record.sourceObservationIds))].sort(compareStrings),
    content: {
      summaryZh: `同类经历合并 ${records.length} 次：${first.content.summaryZh}`,
      counterpartIds: [...new Set(records.flatMap((record) => record.content.counterpartIds))].sort(compareStrings),
      data: {
        ...data,
        mergedCount: records.length,
        mergedAtTick: dueTick,
      },
    },
  };
}

function updatedRecord(
  record: MemoryRecordView,
  tier: LedgerRow["tier"],
  dueTick: number,
  config: LedgerConfig,
): LedgerRow {
  const baseStrength = currentStrength({ ...record, tier }, config, dueTick);
  const data = objectValue(record.content.data);
  return {
    memoryId: record.memoryId as LedgerRow["memoryId"],
    kind: record.kind,
    tier,
    status: "active",
    epistemic: record.epistemic,
    releasePolicyId: record.releasePolicyId,
    validFromTick: record.validFromTick,
    validUntilTick: record.validUntilTick,
    strength: tier === "core" ? record.salience : baseStrength,
    salience: record.salience,
    recallCount: record.recallCount,
    lastReinforcedTick: record.lastReinforcedTick,
    tags: [...record.tags],
    sourceObservationIds: [...record.sourceObservationIds],
    content: {
      summaryZh: record.content.summaryZh,
      counterpartIds: [...record.content.counterpartIds],
      data,
    },
  };
}
