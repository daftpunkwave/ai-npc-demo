/**
 * 核心职责：按分支公共版本读取编年史，校验来源并原子去重发布。
 * 交互契约：仅在调用者的存储事务中处理公共记录及其公开来源观察。
 * 约束与禁忌：禁止发布私有来源、跨分支读取或使用 Agent 局部 revision 作为公共边界。
 */
import type { MemoryChangePlan, StorageRow, StorageTransaction } from "@ai-npc/contracts";
import { encodeMemoryRow, jsonObject, numberColumn, parseRecord } from "./memory-row-codec";

export const publicMemoryAgentId = "~public";

export function publicRevision(tx: StorageTransaction, branchId: string): number {
  const row = tx.all("SELECT MAX(created_revision) AS revision FROM memory_records WHERE branch_id = ? AND agent_id = ?", [branchId, publicMemoryAgentId])[0];
  return typeof row?.["revision"] === "number" ? row["revision"] : 0;
}

export function publicRows(tx: StorageTransaction, branchId: string, revision: number): readonly StorageRow[] {
  return tx.branch(branchId).table("memory_records").list({ agent_id: publicMemoryAgentId }).filter((row) =>
    numberColumn(row, "created_revision") <= revision &&
    (row["retired_revision"] === null || numberColumn(row, "retired_revision") > revision) &&
    row["status"] === "active",
  );
}

export function validateMemorySources(tx: StorageTransaction, branchId: string, agentId: string, plan: MemoryChangePlan, frozenPublicRevision: number): void {
  const observations = tx.branch(branchId).table("observations");
  const sharedSources = new Set(publicRows(tx, branchId, frozenPublicRevision).flatMap((row) => parseRecord(row).sourceObservationIds));
  for (const insert of plan.inserts) {
    const sources: StorageRow[] = [];
    for (const observationId of insert.sourceObservationIds) {
      const own = observations.list({ agent_id: agentId, observation_id: observationId }, { limit: 1 })[0];
      const source = own ?? (sharedSources.has(observationId)
        ? observations.list({ observation_id: observationId, release_policy_id: "public" }, { limit: 1 })[0]
        : undefined);
      if (source === undefined) throw new Error(`memory source observation ${observationId} does not belong to agent ${agentId} or its frozen public view`);
      sources.push(source);
    }
    if (insert.branchPublic !== true) continue;
    if (insert.kind !== "public" || insert.status !== "active" || insert.releasePolicyId !== "public" || sources.length === 0 ||
      sources.some((source) => source["release_policy_id"] !== "public" || numberColumn(source, "known_at_tick") > insert.validFromTick)) {
      throw new Error("branch-public memory requires active public records with public source observations");
    }
    const eventIds = sources.flatMap((source) => Array.isArray(source["source_event_ids_json"]) ? source["source_event_ids_json"].filter((id): id is string => typeof id === "string") : []);
    const expectedKey = [...new Set(eventIds)].sort().join(",") || [...new Set(insert.sourceObservationIds)].sort().join(",");
    if (jsonObject(insert.content.data)["sourceEventKey"] !== expectedKey) throw new Error("branch-public memory source event key does not match its observations");
  }
}

export function publishPublicRecords(tx: StorageTransaction, branchId: string, moduleId: string, inserts: MemoryChangePlan["inserts"]): number {
  const previous = publicRevision(tx, branchId);
  const current = publicRows(tx, branchId, previous);
  const keys = new Set(current.map((row) => jsonObject(parseRecord(row).content.data)["sourceEventKey"]));
  const ids = new Set(current.map((row) => row["memory_id"]));
  let published = false;
  for (const insert of inserts) {
    if (insert.branchPublic !== true) continue;
    const key = jsonObject(insert.content.data)["sourceEventKey"];
    if (keys.has(key)) continue;
    if (ids.has(insert.memoryId)) throw new Error("branch-public memory cannot replace an existing public ID");
    tx.branch(branchId).table("memory_records").put(encodeMemoryRow({ agentId: publicMemoryAgentId, moduleId, revision: previous + 1, rowVersion: 1, insert }));
    keys.add(key);
    ids.add(insert.memoryId);
    published = true;
  }
  return published ? previous + 1 : previous;
}
