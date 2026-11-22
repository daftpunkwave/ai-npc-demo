/**
 * 解码记忆水位、观察与追加式行版本。
 * 把存储行转换为类型化记忆记录与安全标量值。
 * 禁止执行事务、策略裁决或写入。
 */
import {
  agentObservationSchema,
  type AgentObservation,
  type Json,
  type MemoryChangePlan,
  type MemoryScope,
  type StorageRow,
} from "@ai-npc/contracts";
import type { MemoryRecordView } from "@ai-npc/module-sdk";

export interface MemoryWatermark {
  readonly moduleId: string;
  readonly revision: number;
  readonly observationSeqConsumed: number;
  readonly durableThroughSeq: number;
  readonly derivedThroughSeq: number;
  readonly derivedThroughTick: number;
}

export function numberColumn(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`memory column ${key} is not a non-negative safe integer`);
  }
  return value;
}

export function stringColumn(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`memory column ${key} is not a string`);
  return value;
}

export function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

export function parseWatermark(row: StorageRow): MemoryWatermark {
  return {
    moduleId: stringColumn(row, "module_id"),
    revision: numberColumn(row, "revision"),
    observationSeqConsumed: numberColumn(row, "observation_seq_consumed"),
    durableThroughSeq: numberColumn(row, "durable_through_seq"),
    derivedThroughSeq: numberColumn(row, "derived_through_seq"),
    derivedThroughTick: numberColumn(row, "derived_through_tick"),
  };
}

export function parseObservation(row: StorageRow, scope: MemoryScope): AgentObservation {
  return agentObservationSchema.parse({
    observationId: stringColumn(row, "observation_id"),
    scope,
    observationSeq: numberColumn(row, "observation_seq"),
    sourceEventIds: row["source_event_ids_json"],
    sourceObservationIds: row["source_observation_ids_json"],
    occurredAtTick: numberColumn(row, "occurred_at_tick"),
    sensedAtTick: numberColumn(row, "sensed_at_tick"),
    knownAtTick: numberColumn(row, "known_at_tick"),
    channel: stringColumn(row, "channel"),
    epistemic: stringColumn(row, "epistemic"),
    confidence: typeof row["confidence"] === "number" ? row["confidence"] : Number.NaN,
    releasePolicyId: stringColumn(row, "release_policy_id"),
    content: row["content_json"],
  });
}

export function parseRecord(row: StorageRow): MemoryRecordView {
  const content = jsonObject(row["content_json"]);
  const data = jsonObject(content["data"]);
  return {
    memoryId: stringColumn(row, "memory_id"),
    rowVersion: numberColumn(row, "row_version"),
    kind: stringColumn(row, "kind") as MemoryRecordView["kind"],
    tier: stringColumn(row, "tier") as MemoryRecordView["tier"],
    status: stringColumn(row, "status") as MemoryRecordView["status"],
    epistemic: stringColumn(row, "epistemic") as MemoryRecordView["epistemic"],
    releasePolicyId: stringColumn(row, "release_policy_id"),
    validFromTick: numberColumn(row, "valid_from_tick"),
    validUntilTick: row["valid_until_tick"] === null ? null : numberColumn(row, "valid_until_tick"),
    strength: typeof row["strength"] === "number" ? row["strength"] : 0,
    salience: typeof row["salience"] === "number" ? row["salience"] : 0,
    recallCount: numberColumn(row, "recall_count"),
    lastReinforcedTick: typeof content["_lastReinforcedTick"] === "number"
      ? content["_lastReinforcedTick"]
      : typeof data["_lastReinforcedTick"] === "number"
        ? data["_lastReinforcedTick"]
        : numberColumn(row, "valid_from_tick"),
    tags: Array.isArray(row["tags_json"])
      ? row["tags_json"].filter((value): value is string => typeof value === "string")
      : [],
    sourceObservationIds: Array.isArray(row["source_observation_ids_json"])
      ? row["source_observation_ids_json"].filter((value): value is string => typeof value === "string")
      : [],
    content: {
      summaryZh: typeof content["summaryZh"] === "string" ? content["summaryZh"] : "",
      counterpartIds: Array.isArray(content["counterpartIds"])
        ? content["counterpartIds"].filter((value): value is string => typeof value === "string")
        : [],
      data: content["data"] as Json,
    },
  };
}

export function encodeMemoryRow(input: {
  readonly agentId: string;
  readonly moduleId: string;
  readonly revision: number;
  readonly rowVersion: number;
  readonly insert: MemoryChangePlan["inserts"][number];
}): StorageRow {
  const { insert } = input;
  return {
    agent_id: input.agentId,
    memory_id: insert.memoryId,
    row_version: input.rowVersion,
    module_id: input.moduleId,
    kind: insert.kind,
    tier: insert.tier,
    status: insert.status,
    epistemic: insert.epistemic,
    release_policy_id: insert.releasePolicyId,
    valid_from_tick: insert.validFromTick,
    valid_until_tick: insert.validUntilTick,
    created_revision: input.revision,
    retired_revision: null,
    strength: insert.strength,
    salience: insert.salience,
    recall_count: insert.recallCount,
    tags_json: [...insert.tags],
    source_observation_ids_json: [...insert.sourceObservationIds],
    content_json: {
      summaryZh: insert.content.summaryZh,
      counterpartIds: [...insert.content.counterpartIds],
      data: insert.content.data,
      _lastReinforcedTick: insert.lastReinforcedTick,
    },
  };
}
