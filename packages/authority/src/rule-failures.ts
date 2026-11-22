/**
 * 核心职责：记录 job、事件消费者与时钟步骤的失败尝试，按阶段与主体累计次数并提供死信查询。
 * 交互契约：调用方在事务内传入分支、失败阶段、主体与本次尝试次数；成功路径负责清除记录。
 * 约束与禁忌：不在这里执行处理器、不吞掉错误，也不把失败记录当成已完成结果。
 */
import {
  DomainError,
  isErrorCode,
  type ErrorCode,
  type StoragePort,
  type StorageRow,
  type StorageTransaction,
} from "@ai-npc/contracts";
import { requireStorageNumber, requireStorageString } from "./storage-values";

/** 单个主体允许的失败尝试上限；达到后保留记录并停止重试。 */
export const MAX_RULE_ATTEMPTS = 3;

/** 失败记录覆盖的执行阶段；worker 指宿主 tick worker 本身。 */
export type RuleFailurePhase = "job" | "event" | "clock-step" | "worker";

/** 失败主体标识：jobId、消费者/事件、时钟步骤/tick 或 worker 失败位置。 */
export interface RuleFailureIdentity {
  readonly phase: RuleFailurePhase;
  readonly subjectId: string;
  readonly detail: string;
}

/** 已持久化的失败记录。 */
export interface RuleFailureRecord extends RuleFailureIdentity {
  readonly attempts: number;
  readonly reasonCode: ErrorCode;
  readonly lastError: string;
  readonly status: "retrying" | "failed";
  readonly updatedAt: string;
}

/** 一次失败写入的输入；attempts 与 deadLettered 由调用方按自身队列状态判定。 */
export interface RuleFailureWrite {
  readonly attempts: number;
  readonly error: unknown;
  readonly deadLettered: boolean;
  readonly nowIso: string;
}

/** 处理器失败的唯一异常包装；调用方据此区分处理器错误与基础设施错误。 */
export class RuleExecutionError extends Error {
  readonly phase: RuleFailurePhase;
  readonly subjectId: string;
  readonly detail: string;
  readonly worldSeq: number | null;

  constructor(
    phase: RuleFailurePhase,
    subjectId: string,
    detail: string,
    cause: unknown,
    worldSeq: number | null = null,
  ) {
    super(`${phase} ${subjectId} 处理器失败`, { cause });
    this.name = "RuleExecutionError";
    this.phase = phase;
    this.subjectId = subjectId;
    this.detail = detail;
    this.worldSeq = worldSeq;
  }
}

/** 失败原因码：领域错误沿用自身错误码，其他异常归为插件失败。 */
export function failureReasonCode(error: unknown): ErrorCode {
  return error instanceof DomainError ? error.code : "plugin-failed";
}

/** 截断后的失败消息；只用于持久化诊断，不作为对外安全文案。 */
export function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function failureTable(tx: StorageTransaction, branchId: string) {
  return tx.branch(branchId).table("rule_failures");
}

/** 读取明细列；job 与 worker 使用空字符串表示没有更细的定位信息。 */
function requireStorageText(row: StorageRow, column: string): string {
  // eslint-disable-next-line security/detect-object-injection -- 列名只来自本文件的固定字段。
  const value = row[column];
  if (typeof value !== "string") {
    throw new DomainError("invalid-state", `存储表 rule_failures 的列 ${column} 不是字符串`, {
      details: { table: "rule_failures", column },
    });
  }
  return value;
}

/** 解析一行失败记录；阶段、原因码与状态都必须在登记集合内。 */
function parseRuleFailureRow(row: StorageRow): RuleFailureRecord {
  const phase = requireStorageString(row, "rule_failures", "phase");
  if (phase !== "job" && phase !== "event" && phase !== "clock-step" && phase !== "worker") {
    throw new DomainError("invalid-state", `rule_failures 记录的阶段 ${phase} 未登记`);
  }
  const reasonCode = requireStorageString(row, "rule_failures", "reason_code");
  if (!isErrorCode(reasonCode)) {
    throw new DomainError("invalid-state", `rule_failures 记录的原因码 ${reasonCode} 未登记`);
  }
  const status = requireStorageString(row, "rule_failures", "status");
  if (status !== "retrying" && status !== "failed") {
    throw new DomainError("invalid-state", `rule_failures 记录的状态 ${status} 非法`);
  }
  return {
    phase,
    subjectId: requireStorageString(row, "rule_failures", "subject_id"),
    detail: requireStorageText(row, "detail"),
    attempts: requireStorageNumber(row, "rule_failures", "attempts"),
    reasonCode,
    lastError: requireStorageString(row, "rule_failures", "last_error"),
    status,
    updatedAt: requireStorageString(row, "rule_failures", "updated_at"),
  };
}

/** 读取一个主体的失败记录；没有失败时返回 null。 */
export function readRuleFailure(
  tx: StorageTransaction,
  branchId: string,
  identity: RuleFailureIdentity,
): RuleFailureRecord | null {
  const row = failureTable(tx, branchId).get({
    phase: identity.phase,
    subject_id: identity.subjectId,
    detail: identity.detail,
  });
  return row === null ? null : parseRuleFailureRow(row);
}

/** 写入或更新失败记录；status 由调用方给出的死信判定决定。 */
export function writeRuleFailure(
  tx: StorageTransaction,
  branchId: string,
  identity: RuleFailureIdentity,
  write: RuleFailureWrite,
): void {
  failureTable(tx, branchId).put({
    phase: identity.phase,
    subject_id: identity.subjectId,
    detail: identity.detail,
    attempts: write.attempts,
    reason_code: failureReasonCode(write.error),
    last_error: failureMessage(write.error),
    status: write.deadLettered ? "failed" : "retrying",
    updated_at: write.nowIso,
  });
}

/**
 * 在调用方事务内追加一次失败尝试并返回是否达到死信上限。
 * 事件消费者与时钟步骤共用同一计数口径；job 的尝试次数以 jobs 表为准。
 */
export function recordRuleAttempt(
  tx: StorageTransaction,
  branchId: string,
  identity: RuleFailureIdentity,
  error: unknown,
  nowIso: string,
): boolean {
  const previous = readRuleFailure(tx, branchId, identity);
  const attempts = (previous?.attempts ?? 0) + 1;
  const deadLettered = attempts >= MAX_RULE_ATTEMPTS;
  writeRuleFailure(tx, branchId, identity, { attempts, error, deadLettered, nowIso });
  return deadLettered;
}

/** 处理器成功后清除失败记录，避免健康接口保留已恢复的历史。 */
export function clearRuleFailure(
  tx: StorageTransaction,
  branchId: string,
  identity: RuleFailureIdentity,
): void {
  failureTable(tx, branchId).delete({
    phase: identity.phase,
    subject_id: identity.subjectId,
    detail: identity.detail,
  });
}

/** 读取最近失败记录，供健康摘要展示。 */
export function listRuleFailures(
  storage: StoragePort,
  branchId: string,
  limit = 10,
): readonly RuleFailureRecord[] {
  return storage.transact((tx) =>
    failureTable(tx, branchId)
      .list({}, { orderBy: [{ column: "updated_at", direction: "desc" }], limit })
      .map(parseRuleFailureRow),
  );
}

/** worker 失败主体：同一个在线分支只有一个 tick worker。 */
export const workerFailureIdentity: RuleFailureIdentity = {
  phase: "worker",
  subjectId: "tick-worker",
  detail: "",
};
