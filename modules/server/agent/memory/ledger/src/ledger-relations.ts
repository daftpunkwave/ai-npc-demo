/**
 * 将协议、任务、援助与传闻观察转换为带来源的关系修正行。
 * Builds relation modifiers and row versions from authorized observations.
 * Must not infer facts beyond the frozen observation or global contract tables.
 */
import type { MemoryChangePlan } from "@ai-npc/contracts";
import type {
  MemoryRecordView,
  RevisionView,
} from "@ai-npc/module-sdk";
import type { LedgerConfig } from "./definition";
import {
  type LedgerBuild,
  type LedgerEvent,
  type LedgerRow,
  type RelationModifier,
  dataOf,
  numberValue,
  stringArray,
} from "./ledger-model";

type Ids = (prefix: string) => string;

export function buildRelations(
  events: readonly LedgerEvent[],
  view: RevisionView,
  config: LedgerConfig,
  ids: Ids,
): LedgerBuild {
  const inserts: LedgerRow[] = [];
  const retires = new Map<string, MemoryChangePlan["retires"][number]["status"]>();
  const existingRecordIds = new Set(view.records.map((record) => record.memoryId));
  const knownSources = new Set(view.records.flatMap((record) => record.sourceObservationIds));
  const modifiersByTarget = new Map<string, MemoryRecordView[]>();
  for (const record of view.records) {
    if (record.kind !== "relation" || record.status !== "active") continue;
    const target = dataOf(record)["relationTargetId"];
    if (typeof target !== "string") continue;
    const list = modifiersByTarget.get(target) ?? [];
    list.push(record);
    modifiersByTarget.set(target, list);
  }
  for (const event of events) {
    if (knownSources.has(event.observation.observationId)) continue;
    const modifiers = relationModifiers(event, view);
    for (const modifier of modifiers) {
      const current = modifiersByTarget.get(modifier.targetId) ?? [];
      if (current.length >= config.relationModifiersPerTarget) {
        const weakest = [...current].sort((left, right) =>
          Math.abs(relationWeight(left, event.observation.knownAtTick)) -
            Math.abs(relationWeight(right, event.observation.knownAtTick)) ||
          left.memoryId.localeCompare(right.memoryId),
        )[0];
        if (weakest !== undefined) {
          if (existingRecordIds.has(weakest.memoryId)) {
            retires.set(weakest.memoryId, "evicted");
          } else {
            const insertIndex = inserts.findIndex((row) => row.memoryId === weakest.memoryId);
            if (insertIndex >= 0) inserts.splice(insertIndex, 1);
          }
          current.splice(current.indexOf(weakest), 1);
        }
      }
      const row = relationRow(event, modifier, ids);
      inserts.push(row);
      current.push({
        ...row,
        rowVersion: 0,
        tags: [...row.tags],
        sourceObservationIds: [...row.sourceObservationIds],
        content: {
          ...row.content,
          counterpartIds: [...row.content.counterpartIds],
        },
      });
      modifiersByTarget.set(modifier.targetId, current);
    }
    if (stringArray(event.facts["tags"]).includes("rumor-counter")) {
      for (const targetId of event.counterpartIds) {
        for (const record of modifiersByTarget.get(targetId) ?? []) {
          if (dataOf(record)["cause"] === "rumor-hostile") retires.set(record.memoryId, "superseded");
        }
        inserts.push(relationRow(event, {
          targetId,
          dimension: "trust",
          delta: 1,
          cause: "counter-evidence",
          halfLifeTicks: 120,
        }, ids));
      }
    }
  }
  return {
    inserts,
    retires: [...retires].map(([memoryId, status]) => ({ memoryId, status })),
  };
}

function relationRow(event: LedgerEvent, modifier: RelationModifier, ids: Ids): LedgerRow {
  return {
    memoryId: ids("mem") as LedgerRow["memoryId"],
    kind: "relation",
    tier: "long",
    status: "active",
    epistemic: event.observation.epistemic === "inferred" ? "inference" : "verified-event",
    releasePolicyId: event.observation.releasePolicyId,
    validFromTick: event.observation.knownAtTick,
    validUntilTick: null,
    strength: Math.min(1, Math.abs(modifier.delta) / 8),
    salience: Math.min(1, Math.abs(modifier.delta) / 8),
    recallCount: 0,
    lastReinforcedTick: event.observation.knownAtTick,
    tags: [...event.tags],
    sourceObservationIds: [event.observation.observationId],
    content: {
      summaryZh: event.summaryZh,
      counterpartIds: [modifier.targetId],
      data: {
        relationTargetId: modifier.targetId,
        dimension: modifier.dimension,
        delta: modifier.delta,
        cause: modifier.cause,
        modifiedAtTick: event.observation.knownAtTick,
        halfLifeTicks: modifier.halfLifeTicks,
        eventType: event.eventType,
      },
    },
  };
}

function relationWeight(record: MemoryRecordView, worldTick: number): number {
  const data = dataOf(record);
  const delta = numberValue(data["delta"]) ?? 0;
  const modifiedAtTick = numberValue(data["modifiedAtTick"]) ?? record.validFromTick;
  const halfLifeTicks = numberValue(data["halfLifeTicks"]) ?? 1;
  return delta * (0.5 ** ((worldTick - modifiedAtTick) / Math.max(1, halfLifeTicks)));
}

function relationModifiers(event: LedgerEvent, view: RevisionView): readonly RelationModifier[] {
  const selfId = view.scope.agentId;
  const facts = event.facts;
  const modifiers: RelationModifier[] = [];
  const obligorId = typeof facts["obligorId"] === "string" ? facts["obligorId"] : null;
  if (event.eventType === "AgreementTermFulfilled" && obligorId !== null && obligorId !== selfId) {
    modifiers.push({ targetId: obligorId, dimension: "trust", delta: 6, cause: "fulfilled", halfLifeTicks: 240 });
  }
  if (event.eventType === "AgreementBreached" && obligorId !== null && obligorId !== selfId) {
    modifiers.push({ targetId: obligorId, dimension: "trust", delta: -8, cause: "breach", halfLifeTicks: 480 });
    modifiers.push({ targetId: obligorId, dimension: "affinity", delta: -3, cause: "breach", halfLifeTicks: 240 });
  }
  if (event.eventType === "AgreementActivated") {
    for (const targetId of event.counterpartIds) {
      modifiers.push({ targetId, dimension: "trust", delta: 1, cause: "agreement", halfLifeTicks: 120 });
    }
  }
  if (event.eventType === "GroupRescued") {
    const dispatcherId = typeof facts["dispatcherId"] === "string" ? facts["dispatcherId"] : null;
    for (const targetId of dispatcherId === null ? event.counterpartIds : [dispatcherId]) {
      if (targetId === selfId) continue;
      modifiers.push({ targetId, dimension: "affinity", delta: 5, cause: "aid", halfLifeTicks: 240 });
      modifiers.push({ targetId, dimension: "trust", delta: 3, cause: "aid", halfLifeTicks: 240 });
    }
  }
  if (event.eventType === "ResourcesTransferred" && event.subjectIds.includes(view.identity.factionId)) {
    const dispatcherId = typeof facts["dispatcherId"] === "string" ? facts["dispatcherId"] : null;
    if (dispatcherId !== null && dispatcherId !== selfId) {
      modifiers.push({ targetId: dispatcherId, dimension: "affinity", delta: 5, cause: "aid", halfLifeTicks: 240 });
      modifiers.push({ targetId: dispatcherId, dimension: "trust", delta: 3, cause: "aid", halfLifeTicks: 240 });
    }
  }
  if (event.eventType === "TaskInvitationAnswered") {
    const response = facts["response"];
    if (response === "accept" || response === "decline") {
      for (const targetId of event.counterpartIds) {
        modifiers.push({
          targetId,
          dimension: "affinity",
          delta: response === "accept" ? 2 : -2,
          cause: response === "accept" ? "invite-accepted" : "invite-declined",
          halfLifeTicks: 120,
        });
      }
    }
  }
  if (event.eventType === "InformationShared") {
    const fromId = typeof facts["fromId"] === "string" ? facts["fromId"] : null;
    if (fromId !== null && fromId !== selfId) {
      modifiers.push({ targetId: fromId, dimension: "trust", delta: 2, cause: "shared-evidence", halfLifeTicks: 120 });
    }
  }
  if (isHostilePolicy(event, view)) {
    for (const targetId of event.counterpartIds) {
      modifiers.push({ targetId, dimension: "wariness", delta: 4, cause: "hostile-policy", halfLifeTicks: 240 });
    }
  }
  if (event.eventType === "RumorSpread") {
    for (const targetId of stringArray(facts["aboutIds"])) {
      if (targetId !== selfId) {
        modifiers.push({ targetId, dimension: "wariness", delta: 1, cause: "rumor-hostile", halfLifeTicks: 120 });
      }
    }
  }
  return modifiers;
}

function isHostilePolicy(event: LedgerEvent, view: RevisionView): boolean {
  const key = typeof event.facts["key"] === "string" ? event.facts["key"] : "";
  const next = typeof event.facts["newValue"] === "string" ? event.facts["newValue"] : "";
  if (key === "watergate.allocation" && next === "harbor-first") {
    return view.identity.factionId === "human-earth-alliance" || view.identity.factionId === "species-flora";
  }
  return key === "road.status" && (next === "closed" || next === "restricted");
}
