/**
 * 提供结构化记忆行的确定性解析、评分与关系汇总辅助。
 * Provides deterministic parsing and scoring helpers for structured memory rows.
 * Depends on public observation, memory-plan, and revision-view types.
 * Must not read storage or mutate any record.
 */
import type {
  AgentObservation,
  AgentMemoryQuery,
  Json,
  MemoryChangePlan,
} from "@ai-npc/contracts";
import type {
  MemoryAgentIdentity,
  MemoryRecordView,
  RevisionView,
} from "@ai-npc/module-sdk";
import type { LedgerConfig } from "./definition";

export type JsonObject = Readonly<Record<string, Json>>;
export type LedgerRow = MemoryChangePlan["inserts"][number];

export interface LedgerBuild {
  readonly inserts: LedgerRow[];
  readonly retires: MemoryChangePlan["retires"];
}

export interface LedgerEvent {
  readonly observation: AgentObservation;
  readonly eventType: string;
  readonly summaryZh: string;
  readonly facts: JsonObject;
  readonly subjectIds: readonly string[];
  readonly nodeId: string | null;
  readonly claim: JsonObject | null;
  readonly tags: readonly string[];
  readonly counterpartIds: readonly string[];
}

const relationCauses = [
  "fulfilled",
  "breach",
  "agreement",
  "aid",
  "invite-accepted",
  "invite-declined",
  "shared-evidence",
  "hostile-policy",
  "rumor-hostile",
  "counter-evidence",
] as const;

type RelationCause = (typeof relationCauses)[number];
const relationCauseSet: ReadonlySet<string> = new Set(relationCauses);

export interface RelationModifier {
  readonly targetId: string;
  readonly dimension: "trust" | "affinity" | "wariness";
  readonly delta: number;
  readonly cause: RelationCause;
  readonly halfLifeTicks: number;
}

export interface ProspectiveState {
  readonly sourceKind: "agreement" | "task" | "informal";
  readonly agreementId?: string;
  readonly termIndex?: number;
  readonly obligorId: string;
  readonly dueTick: number | null;
  readonly state: "open" | "closed";
  readonly taskId?: string;
  readonly byId?: string;
}

export function objectValue(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

export function mergeReleasePolicies(policies: readonly string[]): string {
  const unique = [...new Set(policies)].sort(compareStrings);
  const first = unique[0];
  if (first === undefined) return "private:derived";
  if (unique.some((policy) => policy.startsWith("private:"))) {
    return unique.find((policy) => policy.startsWith("private:")) ?? "private:derived";
  }
  if (unique.every((policy) => policy === "public")) return "public";
  if (unique.every((policy) => policy.startsWith("parties:"))) {
    const lists = unique.map((policy) => policy.slice("parties:".length).split(",").filter(Boolean));
    const intersection = lists.slice(1).reduce(
      (current, next) => current.filter((id) => next.includes(id)),
      lists[0] ?? [],
    );
    return intersection.length === 0
      ? "private:derived"
      : `parties:${intersection.sort(compareStrings).join(",")}`;
  }
  if (unique.every((policy) => policy.startsWith("faction:")) && new Set(unique).size === 1) return first;
  if (unique.every((policy) => policy.startsWith("holders:")) && new Set(unique).size === 1) return first;
  return "private:derived";
}

export function dataOf(record: MemoryRecordView): JsonObject {
  return objectValue(record.content.data);
}

export function eventTypeOf(observation: AgentObservation): string {
  const content = objectValue(observation.content);
  return typeof content["eventType"] === "string" ? content["eventType"] : "Unknown";
}

export function summaryOf(observation: AgentObservation): string {
  const content = objectValue(observation.content);
  return typeof content["summaryZh"] === "string"
    ? content["summaryZh"]
    : eventTypeOf(observation);
}

export function factsOf(observation: AgentObservation): JsonObject {
  return objectValue(objectValue(observation.content)["facts"]);
}

export function claimOf(observation: AgentObservation): JsonObject | null {
  const claim = objectValue(observation.content)["claim"];
  return claim === null || claim === undefined ? null : objectValue(claim);
}

export function counterpartIdsOf(observation: AgentObservation, selfId: string): readonly string[] {
  const content = objectValue(observation.content);
  const facts = factsOf(observation);
  const claim = claimOf(observation);
  const ids = new Set<string>([
    ...stringArray(content["subjectIds"]),
    ...stringArray(facts["aboutIds"]),
  ]);
  for (const key of ["sourceId", "senderId", "fromId", "obligorId", "proposerId", "partyId", "dispatcherId", "inviteeId"]) {
    const value = claim?.[key] ?? facts[key];
    if (typeof value === "string") ids.add(value);
  }
  ids.delete(selfId);
  return [...ids].sort(compareStrings);
}

function categoryOf(eventType: string): keyof MemoryAgentIdentity["personalityKeywords"] | null {
  if (eventType.startsWith("Agreement")) return "agreement";
  if (eventType === "GroupRescued" || eventType === "CharacterInjured") return "rescue";
  if (eventType.includes("Resource") || eventType === "StockpileAdjusted" || eventType === "SupplyShortage") {
    return "resource";
  }
  if (eventType.includes("Road") || eventType === "PassageGranted" || eventType.includes("Migration")) {
    return "road";
  }
  if (eventType.includes("Evidence") || eventType === "InformationShared" || eventType === "RumorSpread") {
    return "evidence";
  }
  return null;
}

export function personalityFactor(
  eventType: string,
  facts: JsonObject,
  identity: MemoryAgentIdentity,
): number {
  const policyKey = typeof facts["key"] === "string" ? facts["key"] : "";
  const category = eventType === "PolicyChanged"
    ? policyKey.includes("water")
      ? "resource"
      : policyKey.includes("road")
        ? "road"
        : categoryOf(eventType)
    : eventType === "TaskCompleted" && facts["taskType"] === "rescue"
      ? "rescue"
      : categoryOf(eventType);
  if (category === null) return 1;
  const hit = identity.personalityKeywords[category].some((keyword) =>
    identity.values.some((value) => value.includes(keyword)),
  );
  if (!hit) return 1;
  if (category === "road") return 1.3;
  if (category === "evidence") return 1.3;
  return 1.5;
}

export function baseSalience(event: LedgerEvent): number {
  const taskType = typeof event.facts["taskType"] === "string" ? event.facts["taskType"] : null;
  if (event.eventType === "GroupRescued" || (event.eventType === "TaskCompleted" && taskType === "rescue")) {
    return 0.9;
  }
  if (event.eventType === "AgreementBreached" || event.eventType === "CharacterInjured") return 0.8;
  if (event.eventType === "AgreementTermFulfilled" || event.eventType === "AgreementFulfilled") return 0.7;
  if (
    event.eventType === "AgreementActivated" ||
    event.eventType === "TaskFailed" ||
    event.eventType === "RelayDown" ||
    event.eventType === "OrchardCrisis" ||
    event.eventType === "MigrationCrisis"
  ) {
    return 0.6;
  }
  if (
    event.eventType === "TaskCompleted" ||
    event.eventType === "InformationShared" ||
    event.eventType === "WorldFactRecorded"
  ) {
    return 0.5;
  }
  if (event.eventType === "PolicyChanged" || event.eventType === "PassageGranted") return 0.5;
  if (event.eventType === "TaskInvitationIssued" || event.eventType === "TaskInvitationAnswered") return 0.4;
  if (event.eventType === "RumorSpread") return 0.4;
  if (
    event.eventType === "DialogueSubmitted" ||
    event.eventType === "MessageSent" ||
    event.eventType === "ProbeAsked"
  ) {
    return 0.3;
  }
  if (event.eventType === "MetersChanged" || event.eventType === "DayPassed") return 0.1;
  return 0.2;
}

export function involvementOf(channel: string): number {
  if (["self", "party", "face-to-face", "relay", "evidence", "probe"].includes(channel)) return 1;
  if (channel === "on-site") return 0.5;
  return 0.3;
}

export function tagsFor(event: LedgerEvent): readonly string[] {
  const tags = new Set<string>(event.subjectIds);
  const type = event.eventType;
  if (type.startsWith("Agreement")) tags.add("agreement");
  if (type === "AgreementBreached") tags.add("breach");
  if (type === "AgreementTermFulfilled" || type === "AgreementFulfilled") tags.add("fulfilled");
  if (type.includes("Task")) {
    tags.add("task");
    const taskType = event.facts["taskType"];
    if (typeof taskType === "string") tags.add(taskType);
  }
  if (type.includes("Resource") || type === "StockpileAdjusted" || type === "SupplyShortage") tags.add("resource");
  if (type.includes("Relay")) tags.add("relay");
  if (type.includes("Migration")) tags.add("migration");
  if (type.includes("Orchard")) tags.add("water");
  if (type === "PassageGranted" || type.includes("Road")) tags.add("road");
  if (type === "RumorSpread") tags.add("rumor");
  if (type.includes("Evidence") || type === "InformationShared") tags.add("evidence");
  if (type === "DialogueSubmitted" || type === "MessageSent") tags.add("dialogue");
  if (type === "PolicyChanged") {
    tags.add("policy");
    const key = `${String(event.facts["key"] ?? "")} ${String(event.facts["policyKey"] ?? "")}`;
    if (key.includes("water")) tags.add("water");
    if (key.includes("road")) tags.add("road");
  }
  if (type.includes("Crisis") || type === "RelayDown") tags.add("crisis");
  if (event.nodeId !== null) tags.add(event.nodeId);
  for (const tag of stringArray(event.facts["tags"])) tags.add(tag);
  const evidenceId = event.facts["evidenceId"];
  if (evidenceId === "ev-exchange-draft" || evidenceId === "ev-star-charts") tags.add("exchange");
  return [...tags]
    .filter((tag) => tag.length > 0)
    .sort(compareStrings);
}

export function eventFromObservation(
  observation: AgentObservation,
  selfId: string,
): LedgerEvent {
  const content = objectValue(observation.content);
  const event = {
    observation,
    eventType: eventTypeOf(observation),
    summaryZh: summaryOf(observation),
    facts: factsOf(observation),
    subjectIds: stringArray(content["subjectIds"]),
    nodeId: typeof content["nodeId"] === "string" ? content["nodeId"] : null,
    claim: claimOf(observation),
    tags: [] as readonly string[],
    counterpartIds: counterpartIdsOf(observation, selfId),
  };
  return { ...event, tags: tagsFor(event) };
}

export function currentStrength(
  record: MemoryRecordView,
  config: LedgerConfig,
  worldTick: number,
): number {
  if (record.tier === "core") return record.salience;
  const tier = record.tier === "long" ? "long" : "short";
  const elapsedTicks = Math.max(0, worldTick - record.lastReinforcedTick);
  return record.salience *
    Math.exp(-elapsedTicks / (config.decayBaseTicks[tier] * (1 + record.recallCount)));
}

export function relationModifierWeight(
  record: MemoryRecordView,
  worldTick: number,
): number {
  const data = dataOf(record);
  const delta = numberValue(data["delta"]) ?? 0;
  const modifiedAtTick = numberValue(data["modifiedAtTick"]) ?? record.validFromTick;
  const halfLifeTicks = numberValue(data["halfLifeTicks"]) ?? 1;
  if (data["baseline"] === true) return delta;
  const elapsedTicks = Math.max(0, worldTick - modifiedAtTick);
  return delta * (0.5 ** (elapsedTicks / Math.max(1, halfLifeTicks)));
}

export function relationSummary(
  query: AgentMemoryQuery,
  view: RevisionView,
): ReturnType<typeof buildRelationSummary> {
  return buildRelationSummary(query, view);
}

function buildRelationSummary(
  query: AgentMemoryQuery,
  view: RevisionView,
): {
  targetId: string;
  trust: number;
  affinity: number;
  wariness: number;
  causes: RelationCause[];
  reasonMemoryIds: string[];
}[] {
  const targets = [...new Set(query.counterpartIds)]
    .sort(compareStrings);
  return targets.map((targetId) => {
    const baselineTrust = (view.identity.initialRelations.find((relation) => relation.targetId === targetId)?.trust ?? 0) * 4;
    const totals = { trust: baselineTrust, affinity: 0, wariness: 0 };
    const contributions: { memoryId: string; cause: RelationCause; value: number }[] = [];
    for (const record of view.records) {
      if (record.kind !== "relation" || record.status !== "active") continue;
      const data = dataOf(record);
      if (data["relationTargetId"] !== targetId) continue;
      const dimension = data["dimension"];
      const cause = data["cause"];
      if (
        (dimension !== "trust" && dimension !== "affinity" && dimension !== "wariness") ||
        typeof cause !== "string"
      ) {
        continue;
      }
      const weight = relationModifierWeight(record, query.frontier.worldTick);
      totals[dimension] += weight;
      if (Math.abs(weight) >= 0.1) {
        if (relationCauseSet.has(cause)) {
          const typedCause = cause as RelationCause;
          contributions.push({ memoryId: record.memoryId, cause: typedCause, value: weight });
        }
      }
    }
    return {
      targetId,
      trust: round(totals.trust),
      affinity: round(totals.affinity),
      wariness: round(totals.wariness),
      causes: [...new Set(contributions.map((entry) => entry.cause))],
      reasonMemoryIds: contributions
        .sort((left, right) => Math.abs(right.value) - Math.abs(left.value) || left.memoryId.localeCompare(right.memoryId))
        .slice(0, 2)
        .map((entry) => entry.memoryId),
    };
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
