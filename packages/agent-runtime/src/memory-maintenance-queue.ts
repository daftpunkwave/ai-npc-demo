/**
 * 持久化整理任务、租约、重试与重启恢复。
 * 依赖 storage port、宿主时钟与 ID 服务，以及公开的整理任务数据。
 * 禁止执行模块逻辑或发布记忆 revision。
 */
import { maintenanceTaskSchema } from "@ai-npc/contracts";
import type {
  HostServices,
  Json,
  MaintenanceTask,
  StoragePort,
  StorageRow,
} from "@ai-npc/contracts";

const maxMaintenanceAttempts = 3;

export interface ClaimedMaintenance {
  readonly maintenanceId: string;
  readonly moduleId: string;
  readonly leaseEpoch: number;
  readonly observationSeqThrough: number;
  readonly task: MaintenanceTask;
  readonly row: StorageRow;
}

function numberColumn(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`maintenance column ${key} is not a non-negative safe integer`);
  }
  return value;
}

function stringColumn(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`maintenance column ${key} is not a string`);
  return value;
}

export class MemoryMaintenanceQueue {
  constructor(
    private readonly storage: StoragePort,
    private readonly host: HostServices,
    private readonly runId: string,
    private readonly branchId: string,
    private readonly leaseDurationMs: number,
  ) {}

  recoverInterrupted(): void {
    this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      for (const row of table.list({ branch_id: this.branchId, status: "leased" })) {
        table.put({
          ...row,
          status: "queued",
          lease_expires_at: null,
          error_json: null,
        });
      }
      for (const row of table.list({ branch_id: this.branchId, status: "failed" })) {
        if (numberColumn(row, "lease_epoch") >= maxMaintenanceAttempts) continue;
        table.put({
          ...row,
          status: "queued",
          lease_expires_at: null,
          error_json: null,
        });
      }
    });
  }

  enqueue(agentId: string, task: MaintenanceTask): boolean {
    return this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const existing = table.list({
        branch_id: this.branchId,
        agent_id: agentId,
        trigger: task.trigger,
        due_tick: task.dueTick,
      });
      if (existing.length > 0) return false;
      table.put({
        maintenance_id: this.host.ids("mnt"),
        run_id: this.runId,
        branch_id: this.branchId,
        agent_id: agentId,
        module_id: task.moduleId,
        status: "queued",
        trigger: task.trigger,
        due_tick: task.dueTick,
        observation_seq_through: task.observationSeqThrough,
        task_json: task as unknown as Json,
        base_revision: task.baseRevision,
        lease_epoch: 0,
        lease_expires_at: null,
        error_json: null,
        created_at: this.host.nowIso(),
        ended_at: null,
      });
      return true;
    });
  }

  hasTask(agentId: string, trigger: MaintenanceTask["trigger"], dueTick: number): boolean {
    return this.storage.transact((tx) =>
      tx.rows("maintenance_runs")
        .list({ branch_id: this.branchId, agent_id: agentId, trigger, due_tick: dueTick })
        .length > 0,
    );
  }

  due(limit: number, worldTick: number): readonly ClaimedMaintenance[] {
    const nowIso = this.host.nowIso();
    const nowMs = new Date(nowIso).getTime();
    const claimed: ClaimedMaintenance[] = [];
    this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const candidates = table
        .list({ branch_id: this.branchId }, {
          orderBy: [
            { column: "due_tick" },
            { column: "created_at" },
            { column: "maintenance_id" },
          ],
        })
        .filter((row) => {
          const dueTick = numberColumn(row, "due_tick");
          if (dueTick > worldTick) return false;
          if (row["status"] === "queued") return true;
          return row["status"] === "leased" &&
            typeof row["lease_expires_at"] === "string" &&
            new Date(row["lease_expires_at"]).getTime() <= nowMs;
        })
        .slice(0, Math.max(0, limit));
      for (const row of candidates) {
        const leaseEpoch = numberColumn(row, "lease_epoch") + 1;
        const task = maintenanceTaskSchema.parse(row["task_json"]);
        if (
          task.moduleId !== stringColumn(row, "module_id") ||
          task.dueTick !== numberColumn(row, "due_tick") ||
          task.trigger !== row["trigger"] ||
          task.baseRevision !== numberColumn(row, "base_revision")
        ) {
          throw new Error(`maintenance task ${stringColumn(row, "maintenance_id")} does not match its row`);
        }
        const updated = {
          ...row,
          status: "leased",
          lease_epoch: leaseEpoch,
          lease_expires_at: new Date(nowMs + this.leaseDurationMs).toISOString(),
          error_json: null,
        };
        table.put(updated);
        claimed.push({
          maintenanceId: stringColumn(row, "maintenance_id"),
          moduleId: stringColumn(row, "module_id"),
          leaseEpoch,
          observationSeqThrough: numberColumn(row, "observation_seq_through"),
          task,
          row: updated,
        });
      }
    });
    return claimed;
  }

  fail(
    maintenanceId: string,
    leaseEpoch: number,
    error: Json,
  ): void {
    this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const current = table.get({ maintenance_id: maintenanceId });
      if (
        current === null ||
        current["status"] !== "leased" ||
        numberColumn(current, "lease_epoch") !== leaseEpoch
      ) {
        return;
      }
      table.put({
        ...current,
        status: "failed",
        lease_expires_at: null,
        error_json: error,
        ended_at: this.host.nowIso(),
      });
    });
  }

  defer(maintenanceId: string, leaseEpoch: number): void {
    this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const current = table.get({ maintenance_id: maintenanceId });
      if (
        current === null ||
        current["status"] !== "leased" ||
        numberColumn(current, "lease_epoch") !== leaseEpoch
      ) {
        return;
      }
      table.put({
        ...current,
        status: "queued",
        lease_expires_at: null,
      });
    });
  }

  completeTaskJson(
    maintenanceId: string,
    leaseEpoch: number,
    task: MaintenanceTask,
  ): void {
    this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const current = table.get({ maintenance_id: maintenanceId });
      if (
        current === null ||
        current["status"] !== "leased" ||
        numberColumn(current, "lease_epoch") !== leaseEpoch
      ) {
        throw new Error(`maintenance lease ${maintenanceId} is no longer current`);
      }
      table.put({ ...current, task_json: task as unknown as Json, base_revision: task.baseRevision });
    });
  }
}
