/**
 * 运营幂等日志：按世界、认证主体与 operationId 读取首次结果，或在业务事务内写入结果与失败原因。
 * 依赖存储事务、规范 JSON 与运营结果解码；跨分支切换与进程重启仍有效，不参与分支复制。
 * 可重试失败视为尚未产生已提交结果，允许同一 operationId 重新执行并覆盖；不可重试失败与成功结果保持终态。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口与回调类型签名中的参数名用于表达调用契约。 */
import { createHash } from "node:crypto";
import {
  DomainError,
  canonicalJson,
  clockViewSchema,
  isErrorCode,
  jsonValueSchema,
  type ClockView,
  type ErrorCode,
  type Json,
  type StoragePort,
  type StorageRow,
  type StorageTransaction,
} from "@world-prism/contracts";

/** 运营操作种类；与 operation_idempotency.operation_kind 的约束一致。 */
export type OperationKind = "pause" | "resume" | "step" | "snapshot" | "restore" | "reset";

/** 请求体中的幂等键与认证主体；传输层校验请求结构后传入。 */
export interface OperationActor {
  readonly operationId: string;
  readonly principalId: string;
}

/** 幂等键：世界、认证主体与 operationId；请求内容哈希只用于识别同键不同内容。 */
export interface OperationKey {
  readonly kind: OperationKind;
  readonly worldId: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly requestHash: string;
}

/** 已持久化的首次结果：成功结果或失败原因；失败是否可重试决定它能否被同一 operationId 的后续尝试替换。 */
export type OperationOutcome =
  | { readonly status: "succeeded"; readonly result: Json }
  | { readonly status: "failed"; readonly code: ErrorCode; readonly retryable: boolean; readonly safeMessage: string };

/** 部署级幂等表；不含 branch_id，因此跨在线别名切换与进程重启仍然有效。 */
const operationIdempotencyTable = "operation_idempotency";

/** 运营请求内容哈希：覆盖操作类型与业务字段，复用规范 JSON 保证键顺序无关。 */
export function operationRequestHash(kind: OperationKind, content: Json): string {
  return createHash("sha256").update(canonicalJson({ kind, content })).digest("hex");
}

/** 对客户端公开的错误形状；未预期的宿主异常不携带内部细节。 */
function publicOperationError(error: unknown): {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
} {
  if (error instanceof DomainError) {
    return { code: error.code, retryable: error.retryable, safeMessage: error.safeMessage };
  }
  return { code: "plugin-failed", retryable: false, safeMessage: "服务器内部错误" };
}

/** 终态记录必须与请求内容一致；同键不同内容在读取时明确冲突。 */
function assertSameRequest(row: StorageRow, key: OperationKey): void {
  const storedHash = row["request_hash"];
  if (typeof storedHash !== "string") {
    throw new DomainError("invalid-state", "运营幂等记录缺少请求哈希");
  }
  if (storedHash !== key.requestHash) {
    throw new DomainError("idempotency-conflict", "同一 operationId 已用于不同请求内容", {
      details: { operationId: key.operationId, kind: key.kind },
    });
  }
}

/**
 * 从幂等记录行还原已提交结果：可重试失败按尚未提交处理并返回 null，允许同一 operationId 重新执行；
 * 成功结果与不可重试失败是终态，在读取时校验请求内容与首次一致。
 */
function storedOperationOutcome(row: StorageRow, key: OperationKey): OperationOutcome | null {
  const status = row["status"];
  if (status === "failed") {
    const code = row["error_code"];
    const retryable = row["error_retryable"];
    const safeMessage = row["error_safe_message"];
    if (typeof code !== "string" || !isErrorCode(code)) {
      throw new DomainError("invalid-state", "运营幂等记录的错误码不合法");
    }
    if (typeof retryable !== "number" || (retryable !== 0 && retryable !== 1)) {
      throw new DomainError("invalid-state", "运营幂等记录的重试标记不合法");
    }
    if (typeof safeMessage !== "string" || safeMessage.length === 0) {
      throw new DomainError("invalid-state", "运营幂等记录缺少安全文案");
    }
    // 可重试失败不锁定 operationId：重试可以更换请求内容（包括时钟版本），成功后覆盖该记录。
    if (retryable === 1) {
      return null;
    }
    assertSameRequest(row, key);
    return { status: "failed", code, retryable: false, safeMessage };
  }
  if (status === "succeeded") {
    assertSameRequest(row, key);
    const result = row["result_json"];
    if (result === null || result === undefined || result instanceof Uint8Array) {
      throw new DomainError("invalid-state", "运营幂等记录缺少首次结果");
    }
    return { status: "succeeded", result: result as Json };
  }
  throw new DomainError("invalid-state", "运营幂等记录状态不合法");
}

/** 判断既有记录是否为可被重试替换的失败状态；读不到合法状态时按终态处理，避免破坏已提交结果。 */
function isRetryableFailureRow(row: StorageRow): boolean {
  return row["status"] === "failed" && row["error_retryable"] === 1;
}

/** 把宿主构造的纯数据结果转换为契约 JSON；非法值在这里失败，不写入半成品记录。 */
export function toJsonResult(value: unknown): Json {
  return jsonValueSchema.parse(value);
}

function operationJsonObject(value: Json, label: string): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("invalid-state", `运营幂等记录中的${label}结果不合法`);
  }
  return value as Record<string, Json>;
}

/** 校验并还原时钟结果；记录由宿主自己写入，非法内容说明存储被破坏。 */
export function decodeClockOutcome(value: Json): ClockView {
  const parsed = clockViewSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("invalid-state", "运营幂等记录中的时钟结果不合法");
  }
  return parsed.data;
}

/** 校验并还原快照结果。 */
export function decodeSnapshotOutcome(value: Json): { readonly snapshotId: string; readonly worldTick: number } {
  const record = operationJsonObject(value, "快照");
  const snapshotId = record["snapshotId"];
  const worldTick = record["worldTick"];
  if (typeof snapshotId !== "string" || typeof worldTick !== "number" || !Number.isSafeInteger(worldTick)) {
    throw new DomainError("invalid-state", "运营幂等记录中的快照结果不合法");
  }
  return { snapshotId, worldTick };
}

/** 校验并还原分支切换结果（新分支 ID 与时钟）。 */
export function decodeBranchClockOutcome(value: Json): { readonly branchId: string; readonly clock: ClockView } {
  const record = operationJsonObject(value, "分支");
  const branchId = record["branchId"];
  const clock = record["clock"];
  if (typeof branchId !== "string" || branchId.length === 0 || clock === undefined) {
    throw new DomainError("invalid-state", "运营幂等记录中的分支结果不合法");
  }
  return { branchId, clock: decodeClockOutcome(clock) };
}

/**
 * 运营操作日志：按认证主体与 operationId 读取首次结果，或在同一事务内写入结果。
 * 只读写部署级表，不参与分支复制；写入失败只记录日志，不覆盖原始业务错误。
 */
export class OperationJournal {
  private readonly storage: StoragePort;
  private readonly nowIso: () => string;
  private readonly report: (message: string, error: unknown) => void;

  constructor(storage: StoragePort, nowIso: () => string, report: (message: string, error: unknown) => void) {
    this.storage = storage;
    this.nowIso = nowIso;
    this.report = report;
  }

  /**
   * 在独立读事务中查已提交结果；命中时返回，未命中返回 null，同键不同内容抛冲突。
   * 可重试失败视为未命中，调用方可以重新执行。
   */
  replay<T>(key: OperationKey, decode: (value: Json) => T): T | null {
    const outcome = this.storage.transact((tx) => this.read(tx, key));
    return outcome === null ? null : this.materialize(outcome, decode);
  }

  /**
   * 在调用方事务内读取已提交结果；可重试失败视为没有结果，不做任何写入。
   */
  read(tx: StorageTransaction, key: OperationKey): OperationOutcome | null {
    const row = tx.rows(operationIdempotencyTable).get({
      world_id: key.worldId,
      principal_id: key.principalId,
      operation_id: key.operationId,
    });
    return row === null ? null : storedOperationOutcome(row, key);
  }

  /** 首次结果成功时返回结果；失败时抛出与首次执行相同的领域错误。 */
  materialize<T>(outcome: OperationOutcome, decode: (value: Json) => T): T {
    if (outcome.status === "failed") {
      throw new DomainError(outcome.code, outcome.safeMessage, { retryable: outcome.retryable });
    }
    return decode(outcome.result);
  }

  /**
   * 在独立事务中写入成功结果；仅用于无法把业务写入并入同一事务的时钟控制。
   * 调用方须保证业务写入已经成功。
   */
  recordSuccessStandalone(key: OperationKey, result: Json): void {
    this.storage.transact((tx) => {
      this.recordSuccess(tx, key, result);
    });
  }

  /** 把成功结果写入调用方事务；重试成功时覆盖此前的可重试失败记录，调用方负责把业务写入与本次写入一起提交。 */
  recordSuccess(tx: StorageTransaction, key: OperationKey, result: Json): void {
    tx.rows(operationIdempotencyTable).put({
      world_id: key.worldId,
      principal_id: key.principalId,
      operation_id: key.operationId,
      operation_kind: key.kind,
      request_hash: key.requestHash,
      status: "succeeded",
      result_json: result,
      error_code: null,
      error_retryable: 0,
      error_safe_message: null,
      created_at: this.nowIso(),
    });
  }

  /**
   * 记录本次执行的失败原因。可重试失败允许被后续重试替换或更新；
   * 已提交的成功结果与不可重试失败是终态，不被覆盖；记录写入失败只记日志。
   */
  recordFailure(key: OperationKey, error: unknown): void {
    const published = publicOperationError(error);
    try {
      this.storage.transact((tx) => {
        const existing = tx.rows(operationIdempotencyTable).get({
          world_id: key.worldId,
          principal_id: key.principalId,
          operation_id: key.operationId,
        });
        if (existing !== null && !isRetryableFailureRow(existing)) {
          return;
        }
        tx.rows(operationIdempotencyTable).put({
          world_id: key.worldId,
          principal_id: key.principalId,
          operation_id: key.operationId,
          operation_kind: key.kind,
          request_hash: key.requestHash,
          status: "failed",
          result_json: null,
          error_code: published.code,
          error_retryable: published.retryable ? 1 : 0,
          error_safe_message: published.safeMessage,
          created_at: this.nowIso(),
        });
      });
    } catch (recordError) {
      this.report("运营幂等失败记录写入失败", recordError);
    }
  }
}
