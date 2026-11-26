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

/**
 * 水位未追平时最小的重排间隔（逻辑 tick）。
 * Agent 运行时的轮询远快于世界 tick，不加间隔时同一个未就绪任务会在一个 tick 内被反复认领与延期；
 * 用固定的一个 tick 而不是累加次数，既能消除热循环，也不会让后来已经追平水位的任务被长时间推迟。
 */
const deferMinRetryTicks = 1;

/**
 * 认领前判断任务是否还有资格被推进：失败次数已达上限的持久行不再被认领，
 * 保持 `failed` 作为可查询的最终状态，避免坏任务被无限重复认领。
 * 只认 `failureAttempts`：租约代次会在每次认领时递增，用它冒充失败次数会让正常任务被误判为耗尽。
 *
 * 旧数据兼容：引入 `failureAttempts` 之前写入的行没有该字段。这些行无法区分「失败未达上限」
 * 与「已经耗尽」，因此只在 `status: failed` 时按租约代次推断耗尽——`queued` 与 `leased`
 * 表示任务仍被期待推进，不能因为历史上认领过几次就判死。
 */
function attemptsExhausted(row: StorageRow, task: MaintenanceTask): boolean {
  if (task.failureAttempts !== undefined) return task.failureAttempts >= maxMaintenanceAttempts;
  return row["status"] === "failed" && numberColumn(row, "lease_epoch") >= maxMaintenanceAttempts;
}

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
        if (attemptsExhausted(row, maintenanceTaskSchema.parse(row["task_json"]))) continue;
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
        task_json: { ...task, failureAttempts: 0 },
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

  /** 验证模型调用结束时的租约仍属于本次认领。 */
  isCurrent(maintenanceId: string, leaseEpoch: number): boolean {
    return this.storage.transact((tx) => {
      const current = tx.rows("maintenance_runs").get({ maintenance_id: maintenanceId });
      return current !== null &&
        current["status"] === "leased" &&
        numberColumn(current, "lease_epoch") === leaseEpoch;
    });
  }

  /**
   * 按任务声明的模型配额降级超额的每日整理。
   * 排名只依赖持久化任务字段，避免宿主知道具体记忆模块 ID。
   */
  limitModelTasks(worldTick: number): void {
    this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const groups = new Map<string, { tasks: Array<{ row: StorageRow; task: MaintenanceTask }>; quota: number }>();
      for (const row of table.list({ branch_id: this.branchId })) {
        if (row["status"] === "cancelled") continue;
        if (row["trigger"] !== "day-passed") continue;
        if (numberColumn(row, "due_tick") > worldTick) continue;
        const task = maintenanceTaskSchema.parse(row["task_json"]);
        if (task.modelQuota === undefined) continue;
        const key = `${stringColumn(row, "module_id")}:${task.day ?? Math.floor(task.dueTick / 24)}`;
        const group = groups.get(key) ?? { tasks: [], quota: task.modelQuota };
        group.tasks.push({ row, task });
        group.quota = Math.max(group.quota, task.modelQuota);
        groups.set(key, group);
      }
      for (const { tasks, quota } of groups.values()) {
        const candidates = tasks
          .filter(({ row, task }) => row["status"] === "queued" && task.needsModel && task.modelQuotaGranted === undefined)
          .sort((left, right) =>
            (right.task.modelPriority ?? 0) - (left.task.modelPriority ?? 0) ||
            stringColumn(left.row, "agent_id").localeCompare(stringColumn(right.row, "agent_id")),
          );
        const reserved = tasks.filter(({ task, row }) => task.modelQuotaGranted === true || (row["status"] !== "queued" && task.needsModel)).length;
        for (const [index, { row, task }] of candidates.entries()) {
          const granted = index < Math.max(0, quota - reserved);
          table.put({ ...row, task_json: { ...task, needsModel: granted, modelQuotaGranted: granted } });
        }
      }
    });
  }

  /** 在实际模型调用前原子占用当天名额，失败和晚到结果同样计费。 */
  reserveModelCall(maintenanceId: string, leaseEpoch: number, worldTick: number): (() => void) | void {
    return this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const current = table.get({ maintenance_id: maintenanceId });
      if (current === null || current["status"] !== "leased" || numberColumn(current, "lease_epoch") !== leaseEpoch) {
        throw new Error("memory maintenance model lease is no longer current");
      }
      const task = maintenanceTaskSchema.parse(current["task_json"]);
      if (task.modelQuota === undefined) return;
      const day = Math.floor(worldTick / 24);
      const used = table.list({ branch_id: this.branchId, module_id: task.moduleId }).reduce((sum, row) => {
        const stored = maintenanceTaskSchema.parse(row["task_json"]);
        return sum + (stored.modelCallDays ?? []).filter((value) => value === day).length;
      }, 0);
      if (used >= task.modelQuota) throw new Error("memory maintenance daily model quota exhausted");
      const slot = task.modelCallDays?.length ?? 0;
      table.put({ ...current, task_json: { ...task, modelCallDays: [...(task.modelCallDays ?? []), day] } });
      let released = false;
      return () => {
        if (released) return;
        this.storage.transact((releaseTx) => {
          const releases = releaseTx.rows("maintenance_runs");
          const row = releases.get({ maintenance_id: maintenanceId });
          if (row === null) throw new Error("memory maintenance quota reservation is missing");
          const stored = maintenanceTaskSchema.parse(row["task_json"]);
          const days = [...(stored.modelCallDays ?? [])];
          if (days[slot] !== day) throw new Error("memory maintenance quota reservation changed before release");
          days.splice(slot, 1);
          releases.put({ ...row, task_json: { ...stored, modelCallDays: days } });
        });
        released = true;
      };
    });
  }

  due(limit: number, worldTick: number): readonly ClaimedMaintenance[] {
    const nowIso = this.host.nowIso();
    const nowMs = new Date(nowIso).getTime();
    const claimed: ClaimedMaintenance[] = [];
    this.storage.transact((tx) => {
      const table = tx.rows("maintenance_runs");
      const usedCalls = new Map<string, number>();
      for (const row of table.list({ branch_id: this.branchId })) {
        const task = maintenanceTaskSchema.parse(row["task_json"]);
        const used = (task.modelCallDays ?? []).filter((day) => day === Math.floor(worldTick / 24)).length;
        usedCalls.set(task.moduleId, (usedCalls.get(task.moduleId) ?? 0) + used);
      }
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
          const task = maintenanceTaskSchema.parse(row["task_json"]);
          // 重排点未到：说明上一轮判过「水位未追平」，此时不重复认领，
          // 否则同一个未就绪任务会在每个轮询周期被重新拾起。
          // 只有当世界时钟确实越过重排点时才会重新尝试，重排点本身按 tick 推进而非按尝试次数累加，
          // 因此后来已追平水位的任务不会被长期推迟。
          if ((task.retryAfterTick ?? 0) > worldTick) return false;
          if (task.needsModel && task.modelQuota !== undefined && (usedCalls.get(task.moduleId) ?? 0) >= task.modelQuota) return false;
          if (row["status"] === "queued") return !attemptsExhausted(row, task);
          if (row["status"] === "failed") return !attemptsExhausted(row, task);
          return row["status"] === "leased" &&
            typeof row["lease_expires_at"] === "string" &&
            new Date(row["lease_expires_at"]).getTime() <= nowMs &&
            !attemptsExhausted(row, task);
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
        task_json: { ...maintenanceTaskSchema.parse(current["task_json"]), failureAttempts: (maintenanceTaskSchema.parse(current["task_json"]).failureAttempts ?? 0) + 1 },
        ended_at: this.host.nowIso(),
      });
    });
  }

  /**
   * 延期任务并在逻辑时间上重排，避免持续 `not-ready` 的 Agent 每轮都被重新认领。
   * 重排不消耗 `failureAttempts`：水位未追平不是任务本身的失败，只是还没轮到它。
   */
  defer(maintenanceId: string, leaseEpoch: number, worldTick: number): void {
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
      const stored = maintenanceTaskSchema.parse(current["task_json"]);
      table.put({
        ...current,
        status: "queued",
        lease_expires_at: null,
        task_json: {
          ...stored,
          // 保留配额等待写下的更晚时间点，取两者中较晚者。
          retryAfterTick: Math.max(stored.retryAfterTick ?? 0, worldTick + deferMinRetryTicks),
        },
      });
    });
  }

  /**
   * 健康摘要用的维护队列计数：
   * - `queued`：仍在等待推进的行（含重排未到期与已被认领但未终结的行）；
   * - `exhausted`：失败次数已达上限、不会再被认领的持久行。
   *
   * 两者分开命名，避免把「不会再被推进」的行混进「排队中」的数字。
   * 只读持久行、不认领任务，因此可安全地在概览路径调用。
   */
  queueSummary(): { readonly queued: number; readonly exhausted: number } {
    return this.storage.transact((tx) => {
      let queued = 0;
      let exhausted = 0;
      for (const row of tx.rows("maintenance_runs").list({ branch_id: this.branchId })) {
        const status = row["status"];
        if (status === "completed" || status === "cancelled") continue;
        if (status === "failed" && attemptsExhausted(row, maintenanceTaskSchema.parse(row["task_json"]))) {
          exhausted += 1;
          continue;
        }
        queued += 1;
      }
      return { queued, exhausted };
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
      const stored = maintenanceTaskSchema.parse(current["task_json"]);
      table.put({
        ...current,
        task_json: { ...task, ...(stored.modelCallDays === undefined ? {} : { modelCallDays: stored.modelCallDays }) },
        base_revision: task.baseRevision,
        // 重算可能扩大观察范围；任务行与 JSON 同步，避免下次认领回退到旧范围。
        observation_seq_through: task.observationSeqThrough,
      });
    });
  }
}
