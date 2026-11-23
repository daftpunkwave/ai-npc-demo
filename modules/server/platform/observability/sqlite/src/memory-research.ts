/**
 * 核心职责：查询 Agent 的不可变记忆 revision、记忆差异与观察分页。
 * 交互契约：依赖 StoragePort 的固定表和 scope 解析；不执行召回、压缩或写入。
 * 约束与禁忌：不得返回 revision 之外的行，也不得用空数组掩盖非法存储 JSON。
 */
import {
  DomainError,
  jsonValueSchema,
  memoryDiffResponseSchema,
  memoryResponseSchema,
  observationsResponseSchema,
  type Json,
  type MemoryDiffResponse,
  type MemoryResponse,
  type ObservationsResponse,
  type StoragePort,
  type StorageRawRow,
  type StorageRow,
} from "@ai-npc/contracts";
import { decodeMemoryRecord, decodeObservation, numberColumn } from "./research-codec";

function readWorldId(storage: StoragePort, branchId: string): string {
  const worldId = storage.transact((tx) => tx.rows("branches").get({ branch_id: branchId })?.["world_id"]);
  if (typeof worldId !== "string") throw new DomainError("not-found", `分支 ${branchId} 不存在`);
  return worldId;
}

function observationRow(row: StorageRawRow): StorageRow {
  const text = (key: string): string => {
    // key 只由本文件固定观察字段名调用，不接受请求输入。
    // eslint-disable-next-line security/detect-object-injection
    const value = row[key];
    if (typeof value !== "string") throw new DomainError("invalid-state", `观察字段 ${key} 不是文本`);
    return value;
  };
  const integer = (key: string): number => {
    // eslint-disable-next-line security/detect-object-injection
    const value = row[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new DomainError("invalid-state", `观察字段 ${key} 不是非负整数`);
    }
    return value;
  };
  const finite = (key: string): number => {
    // eslint-disable-next-line security/detect-object-injection
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new DomainError("invalid-state", `观察字段 ${key} 不是有限数字`);
    }
    return value;
  };
  const parse = (key: string): Json => {
    try {
      return jsonValueSchema.parse(JSON.parse(text(key)));
    } catch {
      throw new DomainError("invalid-state", `观察字段 ${key} 不是合法 JSON`);
    }
  };
  return {
    observation_id: text("observation_id"),
    observation_seq: integer("observation_seq"),
    source_event_ids_json: parse("source_event_ids_json"),
    source_observation_ids_json: parse("source_observation_ids_json"),
    occurred_at_tick: integer("occurred_at_tick"),
    sensed_at_tick: integer("sensed_at_tick"),
    known_at_tick: integer("known_at_tick"),
    channel: text("channel"),
    epistemic: text("epistemic"),
    confidence: finite("confidence"),
    release_policy_id: text("release_policy_id"),
    content_json: parse("content_json"),
  };
}

export function readMemory(
  storage: StoragePort,
  branchId: string,
  agentId: string,
  revision: number,
): MemoryResponse {
  const worldId = readWorldId(storage, branchId);
  const watermark = storage.transact((tx) =>
    tx.branch(branchId).table("memory_watermarks").get({ agent_id: agentId }));
  const committedRevision = watermark === null ? 0 : watermark["revision"];
  if (typeof committedRevision !== "number" || !Number.isSafeInteger(committedRevision) ||
    committedRevision < 0) {
    throw new DomainError("invalid-state", `Agent ${agentId} 的记忆水位不是非负整数`);
  }
  if (revision > committedRevision) {
    throw new DomainError("not-found", `记忆 revision ${revision} 尚未提交`);
  }
  const rows = storage.transact((tx) => tx.branch(branchId).table("memory_records")
    .list({ agent_id: agentId }, { orderBy: [{ column: "memory_id" }, { column: "row_version" }] })
    .filter((row) => {
      if (numberColumn(row, "created_revision") > revision) return false;
      return row["retired_revision"] === null || numberColumn(row, "retired_revision") > revision;
    }));
  return memoryResponseSchema.parse({
    revision,
    records: rows.map((row) => decodeMemoryRecord(row, { worldId, branchId, agentId, revision })),
  });
}

export function readMemoryDiff(
  storage: StoragePort,
  branchId: string,
  agentId: string,
  from: number,
  to: number,
): MemoryDiffResponse {
  const before = new Map(readMemory(storage, branchId, agentId, from).records.map((record) => [record.memoryId, record]));
  const after = new Map(readMemory(storage, branchId, agentId, to).records.map((record) => [record.memoryId, record]));
  const added = [...after.keys()].filter((memoryId) => !before.has(memoryId));
  const retired = [...before.keys()].filter((memoryId) => !after.has(memoryId));
  const changed = [...after.keys()].filter((memoryId) => {
    const previous = before.get(memoryId);
    const next = after.get(memoryId);
    return previous !== undefined && next !== undefined && (
      previous.status !== next.status ||
      JSON.stringify(previous.content) !== JSON.stringify(next.content) ||
      JSON.stringify(previous.sourceObservationIds) !== JSON.stringify(next.sourceObservationIds)
    );
  });
  const entry = (memoryId: string) => {
    const record = after.get(memoryId) ?? before.get(memoryId);
    return {
      memoryId: memoryId as MemoryDiffResponse["added"][number]["memoryId"],
      sourceObservationIds: record?.sourceObservationIds ?? [],
    };
  };
  return memoryDiffResponseSchema.parse({
    added: added.map(entry),
    retired: retired.map(entry),
    changed: changed.map(entry),
  });
}

export function readObservations(
  storage: StoragePort,
  branchId: string,
  agentId: string,
  fromSeq: number,
  limit: number,
): ObservationsResponse {
  const worldId = readWorldId(storage, branchId);
  const bounded = Math.max(1, Math.min(limit, 200));
  const rows = storage.transact((tx) => tx.all(
    `SELECT observation_id, observation_seq, source_event_ids_json, source_observation_ids_json,
            occurred_at_tick, sensed_at_tick, known_at_tick, channel, epistemic,
            confidence, release_policy_id, content_json
       FROM observations
      WHERE branch_id = ? AND agent_id = ? AND observation_seq > ?
      ORDER BY observation_seq ASC LIMIT ?`,
    [branchId, agentId, fromSeq, bounded],
  ).map(observationRow));
  return observationsResponseSchema.parse({
    observations: rows.map((row) => decodeObservation(row, { worldId, branchId, agentId })),
  });
}
