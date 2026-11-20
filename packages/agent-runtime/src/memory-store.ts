/**
 * 封装不可变记忆 revision、水位与追加式行版本发布。
 * Encapsulates immutable memory revisions, watermarks, and append-only row publication.
 * Depends on the storage port and public memory, observation, and scope contracts.
 * Must not call modules, models, or expose cross-agent reads.
 */
import { maintenanceTaskSchema } from "@ai-npc/contracts";
import {
  type AgentObservation,
  type HostServices,
  type Json,
  type MemoryChangePlan,
  type MemoryScope,
  type StoragePort,
  type StorageRow,
  type StorageTransaction,
} from "@ai-npc/contracts";
import type {
  MemoryAgentIdentity,
  RevisionView,
} from "@ai-npc/module-sdk";
import {
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
      const table = tx.branch(this.branchId).table("observations");
      return tx.all(
        `SELECT observation_seq FROM observations
         WHERE branch_id = ? AND agent_id = ? AND observation_seq > ?
         ORDER BY observation_seq ASC`,
        [this.branchId, agentId, afterSeq],
      )
        .map((row) => table.get({
          agent_id: agentId,
          observation_seq: numberColumn(row, "observation_seq"),
        }))
        .filter((row): row is StorageRow => row !== null)
        .map((row) => parseObservation(row, scope));
    });
  }

  latestDayPassed(agentId: string): { readonly tick: number; readonly observationSeq: number } | null {
    return this.storage.transact((tx) => {
      const rows = tx.branch(this.branchId)
        .table("observations")
        .list({ agent_id: agentId }, { orderBy: [{ column: "known_at_tick", direction: "desc" }] });
      for (const row of rows) {
        const content = jsonObject(row["content_json"]);
        if (content["eventType"] === "DayPassed") {
          return {
            tick: numberColumn(row, "known_at_tick"),
            observationSeq: numberColumn(row, "observation_seq"),
          };
        }
      }
      return null;
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
      const records = tx.branch(this.branchId)
        .table("memory_records")
        .list({ agent_id: agentId })
        .filter((row) =>
          numberColumn(row, "created_revision") <= revision &&
          (row["retired_revision"] === null || numberColumn(row, "retired_revision") > revision) &&
          row["status"] === "active",
        )
        .sort((left, right) =>
          stringColumn(left, "memory_id").localeCompare(stringColumn(right, "memory_id")) ||
          numberColumn(left, "row_version") - numberColumn(right, "row_version"),
        )
        .map((row) => parseRecord(row));
      return {
        scope: this.scope(agentId),
        revision,
        identity,
        records,
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
      const watermark = this.requireWatermark(tx, agentId, moduleId);
      if (watermark.revision !== plan.baseRevision) {
        throw new Error(`memory CAS mismatch for ${agentId}: expected ${plan.baseRevision}, current ${watermark.revision}`);
      }
      this.validatePlanSources(tx, agentId, plan);
      const currentRows = this.currentRows(tx, agentId);
      const currentById = new Map(currentRows.map((record) => [record.memoryId, record]));
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
      for (const insert of plan.inserts) {
        const current = currentById.get(insert.memoryId);
        const nextRowVersion = (current?.rowVersion ?? this.maxRowVersion(tx, agentId, insert.memoryId)) + 1;
        records.put(encodeMemoryRow({
          agentId,
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
        const task = tx.rows("maintenance_runs").get({
          maintenance_id: options.maintenance.maintenanceId,
        });
        if (
          task === null ||
          task["status"] !== "leased" ||
          numberColumn(task, "lease_epoch") !== options.maintenance.leaseEpoch
        ) {
          throw new Error(`maintenance lease ${options.maintenance.maintenanceId} is no longer current`);
        }
        tx.rows("maintenance_runs").put({
          ...task,
          status: "completed",
          base_revision: revision,
          task_json: {
            ...maintenanceTaskSchema.parse(task["task_json"]),
            baseRevision: plan.baseRevision,
            observationSeqThrough: plan.observationSeqThrough,
          },
          lease_expires_at: null,
          error_json: null,
          ended_at: this.host.nowIso(),
        });
      }
      return revision;
    });
  }

  private validatePlanSources(
    tx: StorageTransaction,
    agentId: string,
    plan: MemoryChangePlan,
  ): void {
    const observations = tx.branch(this.branchId).table("observations");
    for (const row of plan.inserts) {
      for (const observationId of row.sourceObservationIds) {
        if (observations.list({ agent_id: agentId, observation_id: observationId }, { limit: 1 }).length === 0) {
          throw new Error(`memory source observation ${observationId} does not belong to agent ${agentId}`);
        }
      }
    }
  }

  private currentRows(tx: StorageTransaction, agentId: string): readonly CurrentRecord[] {
    return tx.branch(this.branchId)
      .table("memory_records")
      .list({ agent_id: agentId })
      .filter((row) => row["retired_revision"] === null)
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
