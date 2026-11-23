/**
 * 核心职责：实现 M2 观察流与反思记录的候选筛选、归一分与预算内选取。
 * 交互契约：只读取冻结 revision 与查询，不调用模型、存储或跨 Agent 数据。
 * 约束与禁忌：禁止关系账本、隐式随机或绕过 maxItems/maxTokens。
 */
import type { AgentMemoryQuery, MemoryBundle, MemoryChangePlan } from "@ai-npc/contracts";
import type { MemoryRecordView, RevisionView } from "@ai-npc/module-sdk";
import type { StreamReflectionConfig } from "./definition";
import { compareStrings, dataOf, numberValue } from "./ledger-model";

export function retrieveStreamMemory(
  query: AgentMemoryQuery,
  view: RevisionView,
  config: StreamReflectionConfig,
): MemoryBundle {
  const tick = query.frontier.worldTick;
  const all = view.records.filter((record) =>
    record.status === "active" &&
    record.kind !== "relation" &&
    record.validFromTick <= tick,
  );
  const recent = [...all]
    .sort((left, right) => right.validFromTick - left.validFromTick || left.memoryId.localeCompare(right.memoryId))
    .slice(0, 10);
  const relevant = all.filter((record) =>
    record.tags.some((tag) => query.queryTags.includes(tag)) ||
    record.content.counterpartIds.some((id) => query.counterpartIds.includes(id)),
  );
  const candidates = uniqueRecords([...relevant, ...recent])
    .sort((left, right) => right.validFromTick - left.validFromTick || left.memoryId.localeCompare(right.memoryId))
    .slice(0, config.retrieval.candidateLimit);
  if (candidates.length === 0) {
    return { status: "ok", revision: view.revision, coreBlock: null, relationSummary: [], items: [], candidates: 0, dropped: [] };
  }
  const relevance = normalize(candidates.map((record) => relevanceScore(record, query)));
  const recency = normalize(candidates.map((record) =>
    config.retrieval.recencyDecayPerTick ** Math.max(0, tick - record.validFromTick),
  ));
  const importance = normalize(candidates.map((record) => importanceOf(record) / 10));
  const scored = candidates.map((record, index) => ({
    record,
    score:
      relevance[index]! * config.retrieval.weights.relevance +
      recency[index]! * config.retrieval.weights.recency +
      importance[index]! * config.retrieval.weights.importance,
  })).sort((left, right) =>
    right.score - left.score ||
    right.record.validFromTick - left.record.validFromTick ||
    left.record.memoryId.localeCompare(right.record.memoryId),
  );
  const picked: MemoryBundle["items"] = [];
  const dropped: MemoryBundle["dropped"] = [];
  const seenSources = new Set<string>();
  let tokenEstimate = 0;
  for (const item of scored) {
    if (picked.length >= Math.min(config.retrieval.topK, query.maxItems)) break;
    const sourceKey = item.record.sourceObservationIds.slice().sort(compareStrings).join(",");
    if (sourceKey.length > 0 && seenSources.has(sourceKey)) {
      dropped.push({ memoryId: item.record.memoryId, reason: "dedupe" });
      continue;
    }
    const itemTokens = Array.from(item.record.content.summaryZh).length;
    if (tokenEstimate + itemTokens > query.maxTokens) {
      dropped.push({ memoryId: item.record.memoryId, reason: "budget" });
      continue;
    }
    seenSources.add(sourceKey);
    tokenEstimate += itemTokens;
    picked.push({
      memoryId: item.record.memoryId,
      kind: item.record.kind,
      epistemic: item.record.epistemic,
      summaryZh: item.record.content.summaryZh,
      validFromTick: item.record.validFromTick,
      score: item.score,
      mustInclude: false,
      releasePolicyId: item.record.releasePolicyId,
      sourceObservationIds: [...item.record.sourceObservationIds],
    });
  }
  const pickedIds = new Set(picked.map((item) => item.memoryId));
  for (const item of scored) {
    if (!pickedIds.has(item.record.memoryId) && !dropped.some((entry) => entry.memoryId === item.record.memoryId)) {
      dropped.push({ memoryId: item.record.memoryId, reason: "rank" });
    }
  }
  return { status: "ok", revision: view.revision, coreBlock: null, relationSummary: [], items: picked, candidates: candidates.length, dropped };
}

type MemoryRowLike = MemoryRecordView | MemoryChangePlan["inserts"][number];

export function importanceOf(record: MemoryRowLike): number {
  const data = record.content.data;
  const value = typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)["importance"]
    : undefined;
  return numberValue(value) ?? Math.round(record.salience * 9) + 1;
}

function relevanceScore(record: MemoryRecordView, query: AgentMemoryQuery): number {
  const tags = new Set(record.tags);
  const queryTags = new Set(query.queryTags);
  const intersection = [...tags].filter((tag) => queryTags.has(tag)).length;
  const union = new Set([...tags, ...queryTags]).size;
  const tagScore = union === 0 ? 0 : intersection / union;
  const bigramScore = dice(bigrams(record.content.summaryZh), bigrams(query.queryText));
  return 0.6 * tagScore + 0.4 * bigramScore;
}

function bigrams(value: string): ReadonlySet<string> {
  const chars = Array.from(value.replace(/\s+/g, ""));
  if (chars.length < 2) return new Set(chars);
  return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
}

function dice(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  const overlap = [...left].filter((value) => right.has(value)).length;
  return (2 * overlap) / (left.size + right.size);
}

function normalize(values: readonly number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return values.map(() => 0);
  return values.map((value) => (value - min) / (max - min));
}

function uniqueRecords(records: readonly MemoryRecordView[]): MemoryRecordView[] {
  return [...new Map(records.map((record) => [record.memoryId, record])).values()];
}