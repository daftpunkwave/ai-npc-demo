/**
 * 核心职责：查询 Agent 的不可变记忆 revision、记忆差异与观察分页。
 * 交互契约：经数据源端口读取分支所属世界、记忆水位、记忆行版本与观察；不执行召回、压缩或写入。
 * 约束与禁忌：不得返回 revision 之外的行，也不得用空数组掩盖非法存储数据。
 */
import {
  DomainError,
  memoryDiffResponseSchema,
  memoryResponseSchema,
  observationsResponseSchema,
  type MemoryDiffResponse,
  type MemoryResponse,
  type ObservationsResponse,
} from "@world-prism/contracts";
import type { ObservabilitySourceReader, ObservabilitySources, ObservedMemoryRecord } from "@world-prism/module-sdk";
import { decodeMemoryRecord, decodeObservation } from "./research-codec";

function worldIdOf(reader: ObservabilitySourceReader, branchId: string): string {
  const worldId = reader.branchWorldId(branchId);
  if (worldId === null) throw new DomainError("not-found", `分支 ${branchId} 不存在`);
  return worldId;
}

/** 某个已提交 revision 下可见的记忆：行版本的可见区间为 [createdRevision, retiredRevision)。 */
function memorySnapshot(
  reader: ObservabilitySourceReader,
  branchId: string,
  agentId: string,
  revision: number,
): {
  readonly response: MemoryResponse;
  readonly records: ReadonlyMap<string, ObservedMemoryRecord>;
} {
  const worldId = worldIdOf(reader, branchId);
  const committedRevision = reader.memoryWatermark(branchId, agentId)?.revision ?? 0;
  if (revision > committedRevision) {
    throw new DomainError("not-found", `记忆 revision ${revision} 尚未提交`);
  }
  const visible = reader.memoryRecords(branchId, agentId).filter((record) =>
    record.createdRevision <= revision &&
    (record.retiredRevision === null || record.retiredRevision > revision));
  return {
    response: memoryResponseSchema.parse({
      revision,
      records: visible.map((record) => decodeMemoryRecord(record, { worldId, branchId, agentId })),
    }),
    records: new Map(visible.map((record) => [record.memoryId, record])),
  };
}

export function readMemory(
  sources: ObservabilitySources,
  branchId: string,
  agentId: string,
  revision: number,
): MemoryResponse {
  return sources.read((reader) => memorySnapshot(reader, branchId, agentId, revision).response);
}

export function readMemoryDiff(
  sources: ObservabilitySources,
  branchId: string,
  agentId: string,
  from: number,
  to: number,
): MemoryDiffResponse {
  const { beforeSnapshot, afterSnapshot } = sources.read((reader) => ({
    beforeSnapshot: memorySnapshot(reader, branchId, agentId, from),
    afterSnapshot: memorySnapshot(reader, branchId, agentId, to),
  }));
  const before = new Map(beforeSnapshot.response.records.map((record) => [record.memoryId, record]));
  const after = new Map(afterSnapshot.response.records.map((record) => [record.memoryId, record]));
  const added = [...after.keys()].filter((memoryId) => !before.has(memoryId));
  const retired = [...before.keys()].filter((memoryId) => !after.has(memoryId));
  const changed = [...after.keys()].filter((memoryId) => {
    const previous = beforeSnapshot.records.get(memoryId);
    const next = afterSnapshot.records.get(memoryId);
    return previous !== undefined && next !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(next);
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
  sources: ObservabilitySources,
  branchId: string,
  agentId: string,
  fromSeq: number,
  limit: number,
): ObservationsResponse {
  const bounded = Math.max(1, Math.min(limit, 200));
  return sources.read((reader) => {
    const worldId = worldIdOf(reader, branchId);
    return observationsResponseSchema.parse({
      observations: reader.observations(branchId, agentId, fromSeq, bounded)
        .map((observation) => decodeObservation(observation, { worldId, branchId, agentId })),
    });
  });
}
