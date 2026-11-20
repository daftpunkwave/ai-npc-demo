/**
 * 解码 runtime 使用的存储行与事件信封，并构造可持久化触发记录。
 * 依赖公共 JSON、事件和 Agent trigger 契约；不执行事务或业务判断。
 * 禁止把数据库原始字符串直接当作 JSON 对象使用。
 */
import type {
  AgentObservation,
  AgentTrigger,
  AgentTriggerKind,
  EventEnvelope,
  Json,
} from "@ai-npc/contracts";

export function asRecord(value: unknown): Readonly<Record<string, Json>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, Json>>
    : {};
}

export function arrayValue(value: unknown): readonly Json[] {
  return Array.isArray(value) ? value : [];
}

export function jsonValue(value: unknown): Json {
  return typeof value === "string" ? JSON.parse(value) as Json : value as Json;
}

export function stringValue(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`字段 ${key} 不是字符串`);
  return value;
}

export function numberValue(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`字段 ${key} 不是非负整数`);
  }
  return value;
}

export function parseEvent(row: Readonly<Record<string, unknown>>, worldId: string, branchId: string): EventEnvelope {
  return {
    eventId: stringValue(row, "event_id") as EventEnvelope["eventId"],
    schemaVersion: numberValue(row, "schema_version"),
    worldId,
    branchId,
    worldSeq: numberValue(row, "world_seq"),
    worldTick: numberValue(row, "world_tick"),
    type: stringValue(row, "type"),
    principalId: stringValue(row, "principal_id"),
    causationIds: arrayValue(jsonValue(row["causation_ids_json"]))
      .filter((id): id is string => typeof id === "string") as unknown as EventEnvelope["causationIds"],
    correlationId: stringValue(row, "correlation_id"),
    audience: arrayValue(jsonValue(row["audience_json"])) as EventEnvelope["audience"],
    payload: jsonValue(row["payload_json"]),
  };
}

export function triggerFromRow(row: Readonly<Record<string, unknown>>): AgentTrigger {
  return {
    triggerId: stringValue(row, "trigger_id") as AgentTrigger["triggerId"],
    agentId: stringValue(row, "agent_id"),
    kind: stringValue(row, "kind") as AgentTriggerKind,
    priority: numberValue(row, "priority"),
    sourceRef: stringValue(row, "source_ref"),
    createdTick: numberValue(row, "created_tick"),
    dedupeKey: stringValue(row, "dedupe_key"),
    consumedByTurnId:
      row["consumed_by_turn_id"] === null
        ? null
        : stringValue(row, "consumed_by_turn_id") as AgentTrigger["consumedByTurnId"],
  };
}

export function pendingEntry(observation: AgentObservation, triggers: readonly AgentTrigger[]): Json {
  return { observation: observation as unknown as Json, triggers: triggers as unknown as Json[] };
}
