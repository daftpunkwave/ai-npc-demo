/**
 * 核心职责：在记忆发布事务中核验维护租约并保存可恢复的任务结果。
 * 交互契约：接收同一存储事务、已发布 revision、变更计划与宿主时间。
 * 约束与禁忌：禁止单独提交事务，部分结果不得被标记为已完成。
 */
import { maintenanceTaskSchema, type MemoryChangePlan, type StorageTransaction } from "@world-prism/contracts";
import { numberColumn } from "./memory-row-codec";

export function completeMemoryMaintenance(
  tx: StorageTransaction,
  maintenance: { readonly maintenanceId: string; readonly leaseEpoch: number },
  plan: MemoryChangePlan,
  revision: number,
  endedAt: string,
): void {
  const task = tx.rows("maintenance_runs").get({
    maintenance_id: maintenance.maintenanceId,
  });
  if (
    task === null ||
    task["status"] !== "leased" ||
    numberColumn(task, "lease_epoch") !== maintenance.leaseEpoch
  ) {
    throw new Error(`maintenance lease ${maintenance.maintenanceId} is no longer current`);
  }
  const maintenanceResult = plan.maintenanceResult;
  const stored = maintenanceTaskSchema.parse(task["task_json"]);
  const partial = maintenanceResult?.status === "partial";
  const quotaWait = maintenanceResult?.failureReason === "memory maintenance daily model quota exhausted";
  tx.rows("maintenance_runs").put({
    ...task,
    status: partial ? (quotaWait ? "queued" : "failed") : "completed",
    base_revision: revision,
    // 重算会扩大任务范围；任务行与 task_json 必须同步，否则下次认领按旧范围重扫。
    observation_seq_through: plan.observationSeqThrough,
    task_json: {
      ...stored,
      rulesApplied: stored.rulesApplied === true || partial,
      failureAttempts: (stored.failureAttempts ?? 0) + (partial && !quotaWait ? 1 : 0),
      ...(quotaWait ? { retryAfterTick: (Math.max(0, ...(stored.modelCallDays ?? [])) + 1) * 24 } : {}),
      baseRevision: revision,
      observationSeqThrough: plan.observationSeqThrough,
    },
    lease_expires_at: null,
    error_json: maintenanceResult === undefined ||
      (maintenanceResult.status === "completed" && maintenanceResult.discarded.length === 0)
      ? null
      : maintenanceResult,
    ended_at: endedAt,
  });
}
