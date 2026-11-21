/**
 * 将新观察按显著度分流为经历、聚合记录、关系与承诺行。
 * Builds deterministic ingestion rows from a frozen revision view.
 * Must not bypass the memory host or infer records from unobserved events.
 */
import type { AgentObservation, IdPrefix } from "@ai-npc/contracts";
import type { RevisionView } from "@ai-npc/module-sdk";
import type { LedgerConfig } from "./definition";
import {
  type LedgerBuild,
  type LedgerEvent,
  type LedgerRow,
  baseSalience,
  clamp01,
  compareStrings,
  dataOf,
  eventFromObservation,
  involvementOf,
  mergeReleasePolicies,
  numberValue,
  personalityFactor,
} from "./ledger-model";
import { buildProspective } from "./ledger-prospective";
import { buildRelations } from "./ledger-relations";

type Ids = (prefix: IdPrefix) => string;

export function buildIngestion(
  observations: readonly AgentObservation[],
  view: RevisionView,
  config: LedgerConfig,
  ids: Ids,
): LedgerBuild {
  const knownSources = new Set(view.records.flatMap((record) => record.sourceObservationIds));
  const seen = new Set<string>();
  const events = observations
    .filter((observation) => {
      if (seen.has(observation.observationId) || knownSources.has(observation.observationId)) return false;
      seen.add(observation.observationId);
      return true;
    })
    .sort((left, right) => left.observationSeq - right.observationSeq)
    .map((observation) => eventFromObservation(observation, view.scope.agentId));
  const scored = events.map((event, index) => ({
    event,
    salience: salienceOf(event, view, events.slice(0, index)),
  }));
  const significant = scored.filter((entry) => entry.salience >= config.salienceThresholds.short);
  const low = scored.filter((entry) => entry.salience < config.salienceThresholds.short);
  const inserts = significant.map((entry) =>
    rowForEvent(entry.event, entry.salience, config, ids),
  );
  const retires = new Map<string, LedgerBuild["retires"][number]["status"]>();
  const groups = new Map<string, LedgerEvent[]>();
  for (const entry of low) {
    const key = `${Math.floor(entry.event.observation.knownAtTick / 24) + 1}:${entry.event.eventType}`;
    const group = groups.get(key) ?? [];
    group.push(entry.event);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const aggregate = aggregateRow(group, view, ids);
    if (aggregate === null) continue;
    if (view.records.some((record) => record.memoryId === aggregate.memoryId && record.status === "active")) {
      retires.set(aggregate.memoryId, "superseded");
    }
    inserts.push(aggregate);
  }
  if (config.relationInput === "enabled") {
    const relation = buildRelations(events, view, config, ids);
    inserts.push(...relation.inserts);
    for (const entry of relation.retires) retires.set(entry.memoryId, entry.status);
  }
  if (config.prospectiveInput === "enabled") {
    const prospective = buildProspective(events, view, config, ids);
    inserts.push(...prospective.inserts);
    for (const entry of prospective.retires) retires.set(entry.memoryId, entry.status);
  }
  return { inserts, retires: [...retires].map(([memoryId, status]) => ({ memoryId, status })) };
}

function epistemicOf(observation: AgentObservation): LedgerRow["epistemic"] {
  if (observation.epistemic === "witnessed") return "verified-event";
  if (observation.epistemic === "reported") return "reported-claim";
  return "inference";
}

function freshness(
  event: LedgerEvent,
  view: RevisionView,
  priorEvents: readonly LedgerEvent[],
): number {
  const cutoff = event.observation.knownAtTick - 48;
  const existingSources = new Set(view.records.filter((record) => {
    const data = dataOf(record);
    return data["eventType"] === event.eventType &&
      record.validFromTick >= cutoff &&
      record.content.counterpartIds.some((id) => event.counterpartIds.includes(id));
  }).flatMap((record) => record.sourceObservationIds));
  const existing = existingSources.size;
  const newlySeen = priorEvents.filter((candidate) =>
    candidate.eventType === event.eventType &&
    candidate.observation.knownAtTick >= cutoff &&
    candidate.counterpartIds.some((id) => event.counterpartIds.includes(id)),
  ).length;
  return [1.2, 1, 0.8, 0.6][Math.min(existing + newlySeen, 3)] ?? 0.5;
}

function salienceOf(
  event: LedgerEvent,
  view: RevisionView,
  priorEvents: readonly LedgerEvent[],
): number {
  return clamp01(
    baseSalience(event) *
      involvementOf(event.observation.channel) *
      personalityFactor(event.eventType, event.facts, view.identity) *
      freshness(event, view, priorEvents),
  );
}

function rowForEvent(
  event: LedgerEvent,
  salience: number,
  config: LedgerConfig,
  ids: Ids,
): LedgerRow {
  const tier = salience >= config.salienceThresholds.long ? "long" : "short";
  return {
    memoryId: ids("mem") as LedgerRow["memoryId"],
    kind: "episodic",
    tier,
    status: "active",
    epistemic: epistemicOf(event.observation),
    releasePolicyId: event.observation.releasePolicyId,
    validFromTick: event.observation.knownAtTick,
    validUntilTick: null,
    strength: salience,
    salience,
    recallCount: 0,
    lastReinforcedTick: event.observation.knownAtTick,
    tags: [...event.tags],
    sourceObservationIds: [event.observation.observationId],
    content: {
      summaryZh: event.summaryZh,
      counterpartIds: [...event.counterpartIds],
      data: {
        eventType: event.eventType,
        observationSeq: event.observation.observationSeq,
        sourceEventIds: [...event.observation.sourceEventIds],
        facts: event.facts,
        claim: event.claim,
      },
    },
  };
}

function aggregateRow(
  group: readonly LedgerEvent[],
  view: RevisionView,
  ids: Ids,
): LedgerRow | null {
  const first = group[0];
  if (first === undefined) return null;
  const day = Math.floor(first.observation.knownAtTick / 24) + 1;
  const aggregateKey = `aggregate:${day}:${first.eventType}`;
  const existing = view.records.find((record) =>
    record.status === "active" && dataOf(record)["aggregateKey"] === aggregateKey,
  );
  const existingData = existing === undefined ? {} : dataOf(existing);
  const sourceObservationIds = [
    ...new Set([
      ...(existing?.sourceObservationIds ?? []),
      ...group.map((event) => event.observation.observationId),
    ]),
  ].sort(compareStrings);
  if (
    existing !== undefined &&
    group.every((event) => existing.sourceObservationIds.includes(event.observation.observationId))
  ) {
    return null;
  }
  const salience = clamp01((numberValue(existingData["salience"]) ?? 0.1) + group.length * 0.01);
  return {
    memoryId: (existing?.memoryId ?? ids("mem")) as LedgerRow["memoryId"],
    kind: "episodic",
    tier: "short",
    status: "active",
    epistemic: (existing === undefined || existing.epistemic === "verified-event") &&
      group.every((event) => event.observation.epistemic === "witnessed")
      ? "verified-event"
      : "reported-claim",
    releasePolicyId: mergeReleasePolicies(
      [
        ...(existing === undefined ? [] : [existing.releasePolicyId]),
        ...group.map((event) => event.observation.releasePolicyId),
      ],
    ),
    validFromTick: existing?.validFromTick ?? first.observation.knownAtTick,
    validUntilTick: null,
    strength: salience,
    salience,
    recallCount: existing?.recallCount ?? 0,
    lastReinforcedTick: existing?.lastReinforcedTick ?? first.observation.knownAtTick,
    tags: [...new Set([
      ...(existing?.tags ?? []),
      ...group.flatMap((event) => event.tags),
    ])].sort(compareStrings),
    sourceObservationIds,
    content: {
      summaryZh: `第 ${day} 日：收到 ${(numberValue(existingData["count"]) ?? 0) + group.length} 条${first.eventType}通报`,
      counterpartIds: [...new Set([
        ...(existing?.content.counterpartIds ?? []),
        ...group.flatMap((event) => event.counterpartIds),
      ])].sort(compareStrings),
      data: {
        aggregateKey,
        aggregate: true,
        eventType: first.eventType,
        day,
        count: (numberValue(existingData["count"]) ?? 0) + group.length,
        salience,
      },
    },
  };
}
