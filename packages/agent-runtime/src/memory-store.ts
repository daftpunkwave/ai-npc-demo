/**
 * 封装不可变记忆 revision、水位与追加式行版本发布。
 * 依赖 storage port 与公开的 memory、observation、scope 契约。
 * 禁止调用模块与模型，或暴露跨 agent 读取。
 */
import { completeMemoryMaintenance } from "./memory-maintenance-publication";
import { currentMemoryRecordsSql, latestDayPassedSql, visibleMemoryRecordsSql } from "./agent-hot-path-sql";

import { publicRevision, publicRows, publishPublicRecords, validateMemorySources } from "./memory-public-records";
import {
  type AgentObservation,
  type HostServices,
  type Json,
  type MemoryChangePlan,
  type MemoryScope,
  type StoragePort,
  type StorageRow,
  type StorageTransaction,
} from "@world-prism/contracts";
import type {
  MemoryAgentIdentity,
  RevisionView,
} from "@world-prism/module-sdk";
import {
  decodeMemoryRow,
  decodeObservationRow,
  encodeMemoryRow,
  jsonObject,
  numberColumn,
  parseObservation,
  parseRecord,
  parseWatermark,
  stringColumn,
  type MemoryWatermark,
} from "./memory-row-codec";

export type { MemoryWatermark } from "./memory-row-codec";

interface CurrentRecord {
  readonly memoryId: string;
  readonly rowVersion: number;
  readonly row: StorageRow;
}

interface CommitOptions {
  readonly planHash: string;
  readonly worldSeqThrough: number;
  readonly guard?: (tx: StorageTransaction) => void;
  readonly maintenance?: {
    readonly maintenanceId: string;
    readonly leaseEpoch: number;
  };
}

export class MemoryStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
    private readonly worldId: string,
    private readonly branchId: string,
    private readonly runId: string,
  ) {}

  async initializeAgent(agentId: string, moduleId: string): Promise<MemoryWatermark> {
    const existing = this.readWatermark(agentId);
    if (existing !== null) {
      if (existing.moduleId !== moduleId) {
        throw new Error(
          `agent ${agentId} memory module changed from ${existing.moduleId} to ${moduleId}; use a new branch`,
        );
      }
      return existing;
    }
    const planHash = await this.host.hash({ kind: "init", moduleId, runId: this.runId });
    return this.storage.transact((tx) => {
      const branch = tx.branch(this.branchId);
      const current = branch.table("memory_watermarks").get({ agent_id: agentId });
      if (current !== null) return parseWatermark(current);
      branch.table("memory_revisions").put({
        agent_id: agentId,
        revision: 0,
        base_revision: 0,
        observation_seq_through: 0,
        world_seq_through: 0,
        public_revision: publicRevision(tx, this.branchId),
        derived_through_seq: 0,
        change_kind: "init",
        plan_hash: planHash,
        created_at: this.host.nowIso(),
      });
      const watermark: MemoryWatermark = {
        moduleId,
        revision: 0,
        observationSeqConsumed: 0,
        durableThroughSeq: 0,
        derivedThroughSeq: 0,
        derivedThroughTick: 0,
      };
      branch.table("memory_watermarks").put({
        agent_id: agentId,
        module_id: moduleId,
        revision: watermark.revision,
        observation_seq_consumed: watermark.observationSeqConsumed,
        durable_through_seq: watermark.durableThroughSeq,
        derived_through_seq: watermark.derivedThroughSeq,
        derived_through_tick: watermark.derivedThroughTick,
      });
      return watermark;
    });
  }

  readWatermark(agentId: string): MemoryWatermark | null {
    return this.storage.transact((tx) => {
      const row = tx.branch(this.branchId).table("memory_watermarks").get({ agent_id: agentId });
      return row === null ? null : parseWatermark(row);
    });
  }

  readObservations(agentId: string, afterSeq: number): readonly AgentObservation[] {
    return this.storage.transact((tx) => {
      const scope = this.scope(agentId);
      // 单条范围查询直接取回待摄入的全部列：先取主键列表再逐行点查会把一次游标扫描
      // 拆成 N 次语句执行，而 ingestion 每 tick 对每个 Agent 都会走这条路径。
      return tx.all(
        `SELECT observation_id, observation_seq, source_event_ids_json, source_observation_ids_json,
                occurred_at_tick, sensed_at_tick, known_at_tick, channel, epistemic,
                confidence, release_policy_id, content_json
           FROM observations
          WHERE branch_id = ? AND agent_id = ? AND observation_seq > ?
          ORDER BY observation_seq ASC`,
        [this.branchId, agentId, afterSeq],
      )
        .map((row) => parseObservation(decodeObservationRow(row), scope));
    });
  }

  /**
   * 最近一次 DayPassed 观察的 tick 与序号。
   * 条件与 observations_day_passed 部分索引逐字一致：eventType 在 SQL 里过滤，
   * 排序与 LIMIT 也在 SQL 里完成，不再把该 Agent 的全部观察读进内存解码。
   */
  latestDayPassed(agentId: string): { readonly tick: number; readonly observationSeq: number } | null {
    return this.storage.transact((tx) => {
      const row = tx.all(latestDayPassedSql, [this.branchId, agentId])[0];
      if (row === undefined) return null;
      return {
        tick: numberColumn(row, "known_at_tick"),
        observationSeq: numberColumn(row, "observation_seq"),
      };
    });
  }

  readRevisionView(
    agentId: string,
    identity: MemoryAgentIdentity,
    revision: number,
  ): RevisionView {
    return this.storage.transact((tx) => {
      const revisionRow = tx.branch(this.branchId).table("memory_revisions").get({ agent_id: agentId, revision });
      if (revisionRow === null) {
        throw new Error(`agent ${agentId} memory revision ${revision} is not available`);
      }
      // 可见性在 SQL 里按 memory_visible 索引过滤：只把该 revision 可见的行读进内存。
      const records = tx.all(visibleMemoryRecordsSql, [this.branchId, agentId, revision, revision])
        .map((row) => parseRecord(decodeMemoryRow(row)));
      const publicRecords = publicRows(tx, this.branchId, numberColumn(revisionRow, "public_revision"))
        .map((row) => parseRecord(row));
      records.push(...publicRecords);
      records.sort((left, right) =>
        left.memoryId.localeCompare(right.memoryId) || left.rowVersion - right.rowVersion,
      );
      return {
        scope: this.scope(agentId),
        revision,
        identity,
        records,
        derivedThroughSeq: numberColumn(revisionRow, "derived_through_seq"),
      };
    });
  }

  scannedWorldSeq(): number {
    return this.storage.transact((tx) => {
      const value = tx.branch(this.branchId).table("perception_state").max("scanned_through_seq");
      return typeof value === "number" ? value : 0;
    });
  }

  agentControl(agentId: string): { readonly active: boolean; readonly agentControlled: boolean } {
    return this.storage.transact((tx) => {
      const branch = tx.branch(this.branchId);
      const activation = branch.table("agent_activations").get({ agent_id: agentId });
      const lease = branch.table("controller_leases").get({ agent_id: agentId });
      return {
        active: activation?.["status"] === "active",
        agentControlled: lease === null || lease["controller_kind"] === "agent",
      };
    });
  }

  hasRevisionConflicts(agentId: string, baseRevision: number, memoryIds: readonly string[]): boolean {
    if (memoryIds.length === 0) return false;
    return this.storage.transact((tx) => memoryIds.some((memoryId) => {
      const row = tx.all(
        "SELECT MAX(created_revision) AS revision FROM memory_records WHERE branch_id = ? AND agent_id = ? AND memory_id = ?",
        [this.branchId, agentId, memoryId],
      )[0];
      const revision = row?.["revision"];
      return typeof revision === "number" && revision > baseRevision;
    }));
  }

  commitPlan(
    agentId: string,
    moduleId: string,
    plan: MemoryChangePlan,
    options: CommitOptions,
  ): number {
    return this.storage.transact((tx) => {
      options.guard?.(tx);
      const watermark = this.requireWatermark(tx, agentId, moduleId);
      if (watermark.revision !== plan.baseRevision) {
        throw new Error(`memory CAS mismatch for ${agentId}: expected ${plan.baseRevision}, current ${watermark.revision}`);
      }
      const base = tx.branch(this.branchId).table("memory_revisions").get({ agent_id: agentId, revision: plan.baseRevision });
      if (base === null) throw new Error("memory plan base revision is missing");
      validateMemorySources(tx, this.branchId, agentId, plan, numberColumn(base, "public_revision"));
      const currentRows = this.currentRows(tx, agentId);
      const currentById = new Map(currentRows.map((record) => [record.memoryId, record]));
      const { retiredIds, insertedIds } = validateRowChanges(agentId, plan, currentById);
      const revision = watermark.revision + 1;
      const branch = tx.branch(this.branchId);
      const records = branch.table("memory_records");
      for (const record of currentRows) {
        if (!retiredIds.has(record.memoryId)) continue;
        records.put({
          ...record.row,
          retired_revision: revision,
        });
      }
      const sharedRevision = publishPublicRecords(tx, this.branchId, moduleId, plan.inserts);
      for (const insert of plan.inserts) {
        if (insert.branchPublic === true) continue;
        const storageAgentId = agentId;
        const current = currentById.get(insert.memoryId);
        const nextRowVersion = (current?.rowVersion ?? this.maxRowVersion(tx, storageAgentId, insert.memoryId)) + 1;
        records.put(encodeMemoryRow({
          agentId: storageAgentId,
          moduleId,
          revision,
          rowVersion: nextRowVersion,
          insert,
        }));
      }
      for (const retire of plan.retires) {
        if (insertedIds.has(retire.memoryId)) continue;
        const current = currentById.get(retire.memoryId);
        if (current === undefined) continue;
        records.put({
          ...current.row,
          row_version: current.rowVersion + 1,
          status: retire.status,
          created_revision: revision,
          retired_revision: null,
          content_json: current.row["content_json"] as Json,
        });
      }
      branch.table("memory_revisions").put({
        agent_id: agentId,
        revision,
        base_revision: plan.baseRevision,
        observation_seq_through: Math.max(
          watermark.observationSeqConsumed,
          plan.observationSeqThrough,
        ),
        world_seq_through: options.worldSeqThrough,
        public_revision: sharedRevision,
        derived_through_seq: Math.max(watermark.derivedThroughSeq, plan.derivedThroughSeq ?? 0),
        change_kind: plan.changeKind,
        plan_hash: options.planHash,
        created_at: this.host.nowIso(),
      });
      branch.table("memory_watermarks").put({
        agent_id: agentId,
        module_id: moduleId,
        revision,
        observation_seq_consumed: Math.max(
          watermark.observationSeqConsumed,
          plan.observationSeqThrough,
        ),
        durable_through_seq: Math.max(
          watermark.durableThroughSeq,
          plan.observationSeqThrough,
        ),
        derived_through_seq: Math.max(
          watermark.derivedThroughSeq,
          plan.derivedThroughSeq ?? watermark.derivedThroughSeq,
        ),
        derived_through_tick: Math.max(
          watermark.derivedThroughTick,
          plan.derivedThroughTick ?? watermark.derivedThroughTick,
        ),
      });
      if (options.maintenance !== undefined) {
        completeMemoryMaintenance(tx, options.maintenance, plan, revision, this.host.nowIso());
      }
      return revision;
    });
  }

  private currentRows(tx: StorageTransaction, agentId: string): readonly CurrentRecord[] {
    // 只取当前行版本，已退役的历史行版本留在 SQLite 中，不随每次提交读进内存。
    return tx.all(currentMemoryRecordsSql, [this.branchId, agentId])
      .map((row) => decodeMemoryRow(row))
      .sort((left, right) =>
        stringColumn(left, "memory_id").localeCompare(stringColumn(right, "memory_id")) ||
        numberColumn(right, "row_version") - numberColumn(left, "row_version"),
      )
      .map((row) => ({
        memoryId: stringColumn(row, "memory_id"),
        rowVersion: numberColumn(row, "row_version"),
        row,
      }));
  }

  private maxRowVersion(tx: StorageTransaction, agentId: string, memoryId: string): number {
    const row = tx.all(
      "SELECT MAX(row_version) AS version FROM memory_records WHERE branch_id = ? AND agent_id = ? AND memory_id = ?",
      [this.branchId, agentId, memoryId],
    )[0];
    return typeof row?.["version"] === "number" ? row["version"] : 0;
  }

  private requireWatermark(
    tx: StorageTransaction,
    agentId: string,
    moduleId: string,
  ): MemoryWatermark {
    const row = tx.branch(this.branchId).table("memory_watermarks").get({ agent_id: agentId });
    if (row === null) throw new Error(`agent ${agentId} memory is not initialized`);
    const watermark = parseWatermark(row);
    if (watermark.moduleId !== moduleId) {
      throw new Error(`agent ${agentId} memory module does not match its watermark`);
    }
    return watermark;
  }

  private scope(agentId: string): MemoryScope {
    return { worldId: this.worldId, branchId: this.branchId, agentId };
  }
}

function validateRowChanges(
  agentId: string,
  plan: MemoryChangePlan,
  currentById: ReadonlyMap<string, CurrentRecord>,
): { readonly retiredIds: ReadonlySet<string>; readonly insertedIds: ReadonlySet<string> } {
  const retiredIds = new Set(plan.retires.map((entry) => entry.memoryId));
  const insertedIds = new Set(plan.inserts.map((entry) => entry.memoryId));
  if (insertedIds.size !== plan.inserts.length) {
    throw new Error(`memory plan for ${agentId} contains duplicate inserted IDs`);
  }
  for (const retire of plan.retires) {
    if (!currentById.has(retire.memoryId)) {
      throw new Error(`memory retire target ${retire.memoryId} is not current`);
    }
  }
  for (const insert of plan.inserts) {
    if (insert.sourceObservationIds.length === 0) {
      throw new Error(`memory insert ${insert.memoryId} has no source observation`);
    }
    if (currentById.has(insert.memoryId) && !retiredIds.has(insert.memoryId)) {
      throw new Error(`memory update ${insert.memoryId} did not retire its current row version`);
    }
  }
  return { retiredIds, insertedIds };
}
