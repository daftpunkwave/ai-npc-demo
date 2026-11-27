/**
 * 核心职责：登记实验执行器写入的生命周期审计事件类型，并在实验分支上写入与读取这些事件。
 * 交互契约：事件写入 `lifecycle_events`，归属 run 与实验分支，控制台时间线与进度接口按分支读取；
 * 写入经 module-sdk 的统一审计契约。
 * 约束与禁忌：审计事件不是领域事件，不参与世界状态与重放；载荷只放标识、计数与原因码，不放对白正文。
 */
import type { HostServices, Json, StoragePort, StorageTransaction } from "@world-prism/contracts";
import { insertLifecycleAuditEvent, listLifecycleTimeline } from "@world-prism/module-sdk";

/** 执行器写入的审计事件类型；进度接口按这份清单取最近一条。 */
export const experimentAuditTypes = [
  "ExperimentRunStarted",
  "ExperimentStepSubmitted",
  "ExperimentCheckpointReached",
  "ExperimentProbeCompleted",
  "ExperimentRunCompleted",
  "ExperimentRunFailed",
  "ExperimentRunStopped",
  "ExperimentRunInterrupted",
] as const;

export type ExperimentAuditType = (typeof experimentAuditTypes)[number];

/** 一条审计事件的内容。 */
export interface ExperimentAuditEntry {
  readonly runId: string;
  readonly branchId: string;
  readonly type: ExperimentAuditType;
  readonly subjectId: string | null;
  readonly payload: Json;
}

/** 在调用方事务内写入审计事件；与同事务的状态变更一起提交或回滚。 */
export function recordExperimentAuditIn(tx: StorageTransaction, host: HostServices, entry: ExperimentAuditEntry): void {
  insertLifecycleAuditEvent(tx, { ...entry, createdAt: host.nowIso() });
}

/** 单独开事务写入审计事件。 */
export function recordExperimentAudit(storage: StoragePort, host: HostServices, entry: ExperimentAuditEntry): void {
  storage.transact((tx) => { recordExperimentAuditIn(tx, host, entry); });
}

/** 读取实验分支上最近一条执行器审计事件；没有时为 null。 */
export function latestExperimentAudit(
  tx: StorageTransaction,
  branchId: string,
): { readonly type: string; readonly payload: Json; readonly createdAt: string } | null {
  const [latest] = listLifecycleTimeline(tx, { branchId, types: experimentAuditTypes, order: "desc", limit: 1 });
  return latest === undefined ? null : { type: latest.type, payload: latest.payload, createdAt: latest.createdAt };
}
