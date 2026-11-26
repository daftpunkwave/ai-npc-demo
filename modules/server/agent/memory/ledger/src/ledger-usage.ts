/**
 * 处理已验证引用强化、轮次内自报记录与分层容量淘汰。
 * 从冻结 revision 视图构建使用行与有界容量。
 * 禁止仅因记录被检索到就强化它。
 */
import type { MemoryChangePlan } from "@world-prism/contracts";
import type {
  MemoryPort,
  MemoryRecordView,
  RevisionView,
} from "@world-prism/module-sdk";
import type { LedgerConfig } from "./definition";
import {
  type LedgerBuild,
  type LedgerRow,
  currentStrength,
  dataOf,
} from "./ledger-model";

export type CapacityTier = "short" | "long" | "core";

export function applyUsage(
  input: Parameters<MemoryPort["recordUse"]>[0],
  view: RevisionView,
): LedgerBuild {
  const inserts: LedgerRow[] = [];
  const retires: MemoryChangePlan["retires"] = [];
  const cited = [...new Set(input.citedMemoryIds)];
  for (const memoryId of cited) {
    const record = view.records.find((candidate) => candidate.memoryId === memoryId && candidate.status === "active");
    if (record === undefined || dataOf(record)["lastUseTurnId"] === input.turnId) continue;
    inserts.push(reinforcedRow(record, input.turnId, input.worldTick));
    retires.push({ memoryId, status: "superseded" });
  }
  return { inserts, retires };
}

function reinforcedRow(record: MemoryRecordView, turnId: string, worldTick: number): LedgerRow {
  const data = dataOf(record);
  return {
    memoryId: record.memoryId as LedgerRow["memoryId"],
    kind: record.kind,
    tier: record.tier,
    status: "active",
    epistemic: record.epistemic,
    releasePolicyId: record.releasePolicyId,
    validFromTick: record.validFromTick,
    validUntilTick: record.validUntilTick,
    strength: record.salience,
    salience: record.salience,
    recallCount: record.recallCount + 1,
    lastReinforcedTick: worldTick,
    tags: [...record.tags],
    sourceObservationIds: [...record.sourceObservationIds],
    content: {
      summaryZh: record.content.summaryZh,
      counterpartIds: [...record.content.counterpartIds],
      data: { ...data, lastUseTurnId: turnId },
    },
  };
}

export function capacityRetirements(
  build: LedgerBuild,
  view: RevisionView,
  config: LedgerConfig,
  worldTick: number,
  tiers: readonly CapacityTier[] = ["short", "long", "core"],
): LedgerBuild {
  const retires = new Map(build.retires.map((entry) => [entry.memoryId, entry.status]));
  const inserts = [...build.inserts];
  for (const tier of tiers) {
    const existing = view.records.filter((record) =>
      record.status === "active" &&
      record.tier === tier &&
      !retires.has(record.memoryId),
    );
    const pending = inserts.filter((row) =>
      row.tier === tier &&
      row.status === "active",
    );
    let overflow = existing.length + pending.length - config.capacity[tier];
    const candidates = [
      ...existing.map((record) => ({
        memoryId: record.memoryId,
        strength: currentStrength(record, config, worldTick),
        pending: false,
      })),
      ...pending.map((row) => ({
        memoryId: row.memoryId,
        strength: row.strength,
        pending: true,
      })),
    ].sort((left, right) => left.strength - right.strength || left.memoryId.localeCompare(right.memoryId));
    for (const candidate of candidates) {
      if (overflow <= 0) break;
      if (candidate.pending) {
        const index = inserts.findIndex((row) => row.memoryId === candidate.memoryId);
        if (index >= 0) inserts.splice(index, 1);
      } else {
        retires.set(candidate.memoryId, "evicted");
      }
      overflow -= 1;
    }
  }
  return {
    inserts,
    retires: [...retires].map(([memoryId, status]) => ({ memoryId, status })),
  };
}
