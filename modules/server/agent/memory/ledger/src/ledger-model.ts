/**
 * 提供结构化记忆行的确定性解析、评分与关系汇总辅助。
 * 依赖公开的 observation、memory-plan 与 revision-view 类型。
 * 禁止读取存储或改写任何记录。
 */
import type {
  AgentObservation,
  AgentMemoryQuery,
  Json,
  MemoryChangePlan,
} from "@world-prism/contracts";
import type {
  MemoryAgentIdentity,
  MemoryRecordView,
  RevisionView,
} from "@world-prism/module-sdk";
import type { LedgerConfig } from "./definition";

export function requireSameScope(
  left: { readonly worldId: string; readonly branchId: string; readonly agentId: string },
  view: RevisionView,
): void {
  if (left.worldId !== view.scope.worldId || left.branchId !== view.scope.branchId || left.agentId !== view.scope.agentId) {
    throw new Error("memory scope does not match the frozen revision");
  }
}

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
    ...stringArray(facts["parties"]),
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

/**
 * 各事件类型的基础显著度；未登记的类型取 defaultSalience。
 * 用 Map 而不是对象字面量：与对象原型同名的事件类型（如 toString）不能取到原型属性。
 */
const salienceByEventType: ReadonlyMap<string, number> = new Map([
  ["GroupRescued", 0.9],
  ["AgreementBreached", 0.8],
  ["CharacterInjured", 0.8],
  ["AgreementTermFulfilled", 0.7],
  ["AgreementFulfilled", 0.7],
  ["AgreementActivated", 0.6],
  ["TaskFailed", 0.6],
  ["RelayDown", 0.6],
  ["OrchardCrisis", 0.6],
  ["MigrationCrisis", 0.6],
  ["TaskCompleted", 0.5],
  ["InformationShared", 0.5],
  ["WorldFactRecorded", 0.5],
  ["PolicyChanged", 0.5],
  ["PassageGranted", 0.5],
  ["TaskInvitationIssued", 0.4],
  ["TaskInvitationAnswered", 0.4],
  ["RumorSpread", 0.4],
  ["DialogueSubmitted", 0.3],
  ["MessageSent", 0.3],
  ["ProbeAsked", 0.3],
  ["MetersChanged", 0.1],
  ["DayPassed", 0.1],
]);

const defaultSalience = 0.2;

/** 完成的救援任务与群体获救同档；其余任务完成按 TaskCompleted 的登记值计。 */
const rescueSalience = 0.9;

export function baseSalience(event: LedgerEvent): number {
  if (event.eventType === "TaskCompleted" && event.facts["taskType"] === "rescue") return rescueSalience;
  return salienceByEventType.get(event.eventType) ?? defaultSalience;
}

export function involvementOf(channel: string): number {
  if (["self", "party", "face-to-face", "relay", "evidence", "probe"].includes(channel)) return 1;
  if (channel === "on-site") return 0.5;
  return 0.3;
}

/** 只由事件类型决定的标签：类型满足条件即加上对应标签。 */
const eventTypeTags: readonly { readonly tag: string; readonly matches: (type: string) => boolean }[] = [
  { tag: "agreement", matches: (type) => type.startsWith("Agreement") },
  { tag: "breach", matches: (type) => type === "AgreementBreached" },
  { tag: "fulfilled", matches: (type) => type === "AgreementTermFulfilled" || type === "AgreementFulfilled" },
  { tag: "task", matches: (type) => type.includes("Task") },
  { tag: "resource", matches: (type) => type.includes("Resource") || type === "StockpileAdjusted" || type === "SupplyShortage" },
  { tag: "relay", matches: (type) => type.includes("Relay") },
  { tag: "migration", matches: (type) => type.includes("Migration") },
  { tag: "water", matches: (type) => type.includes("Orchard") },
  { tag: "road", matches: (type) => type === "PassageGranted" || type.includes("Road") },
  { tag: "rumor", matches: (type) => type === "RumorSpread" },
  { tag: "evidence", matches: (type) => type.includes("Evidence") || type === "InformationShared" },
  { tag: "dialogue", matches: (type) => type === "DialogueSubmitted" || type === "MessageSent" },
  { tag: "policy", matches: (type) => type === "PolicyChanged" },
  { tag: "crisis", matches: (type) => type.includes("Crisis") || type === "RelayDown" },
];

/** 与交换方案相关的证据；共享或揭示它们的事件额外带 exchange 标签。 */
const exchangeEvidenceIds: ReadonlySet<Json | undefined> = new Set(["ev-exchange-draft", "ev-star-charts"]);

/** 由事件事实派生的标签：任务类型、政策键涉及的领域、节点、事实自带标签与交换相关证据。 */
function factTags(event: LedgerEvent): readonly string[] {
  const { facts, eventType: type } = event;
  const tags: string[] = [...stringArray(facts["tags"])];
  if (type.includes("Task") && typeof facts["taskType"] === "string") tags.push(facts["taskType"]);
  if (type === "PolicyChanged") {
    const key = `${String(facts["key"] ?? "")} ${String(facts["policyKey"] ?? "")}`;
    if (key.includes("water")) tags.push("water");
    if (key.includes("road")) tags.push("road");
  }
  if (event.nodeId !== null) tags.push(event.nodeId);
  if (exchangeEvidenceIds.has(facts["evidenceId"])) tags.push("exchange");
  return tags;
}

/** 合并主体、事件类型与事实派生的标签，去重、去空后按字符串排序。 */
export function tagsFor(event: LedgerEvent): readonly string[] {
  const tags = new Set<string>(event.subjectIds);
  for (const { tag, matches } of eventTypeTags) {
    if (matches(event.eventType)) tags.add(tag);
  }
  for (const tag of factTags(event)) tags.add(tag);
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
