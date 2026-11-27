/**
 * 核心职责：定义生命周期审计事件的统一字段契约、事务内写入，以及供观测数据源使用的只读查询与行解码。
 * 交互契约：调用方提供活跃的存储事务与事件字段；payload 以规范 JSON 序列化后写入 lifecycle_events 表，
 *   读取时在本文件内解码为类型化记录，读取方不需要知道列名与 JSON 存储形态。
 * 约束与禁忌：不得写入领域事件或调用方事务之外的表；插入失败向上抛出，错误处置策略（吞错或随事务回滚）由调用方决定；
 *   查询的筛选与 limit 在 SQL 内完成，按 operationId 查找的表达式必须与迁移建立的 lifecycle_debug_operation 索引逐字一致。
 */
import {
  DomainError,
  canonicalJson,
  jsonValueSchema,
  type Json,
  type StorageRawRow,
  type StorageTransaction,
  type StorageValue,
} from "@world-prism/contracts";
import type { ObservedLifecycleEvent, TimelineFilter } from "./observability-sources";

/**
 * 生命周期审计事件的字段契约；与 lifecycle_events 表列一一对应。
 * 该表是独立于领域事件的 run/控制日志，事件类型是字符串目录而非封闭枚举。
 */
export interface LifecycleAuditEvent {
  /** 归属 run；事件不落在具体 run（如部署级启动）时为 null。 */
  readonly runId: string | null;
  /** 归属分支；事件不落在具体分支时为 null。 */
  readonly branchId: string | null;
  /** 事件类型；时间线按该值过滤读取。 */
  readonly type: string;
  /** 事件主体；无明确主体时为 null。 */
  readonly subjectId: string | null;
  /** 事件载荷；序列化形态由本契约统一为规范 JSON。 */
  readonly payload: Json;
  /** 事件时间（ISO 字符串）。 */
  readonly createdAt: string;
}

/** 在调用方事务内写入一条生命周期审计事件；同一事务内的其他写入与本事件保持原子。 */
export function insertLifecycleAuditEvent(tx: StorageTransaction, event: LifecycleAuditEvent): void {
  tx.run(
    "INSERT INTO lifecycle_events (run_id, branch_id, type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [event.runId, event.branchId, event.type, event.subjectId, canonicalJson(event.payload), event.createdAt],
  );
}

function auditText(row: StorageRawRow, column: string): string {
  // eslint-disable-next-line security/detect-object-injection -- column 来自本文件的固定列名。
  const value = row[column];
  if (typeof value !== "string") {
    throw new DomainError("invalid-state", `生命周期审计列 ${column} 不是文本`);
  }
  return value;
}

function auditPayload(row: StorageRawRow): Json {
  const text = auditText(row, "payload_json");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new DomainError("invalid-state", "生命周期审计载荷不是合法 JSON", { cause });
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("invalid-state", "生命周期审计载荷不符合 JSON 契约");
  return parsed.data;
}

function decodeLifecycleEvent(row: StorageRawRow): ObservedLifecycleEvent {
  const seq = row["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq)) {
    throw new DomainError("invalid-state", "生命周期审计列 seq 不是整数");
  }
  return {
    seq,
    type: auditText(row, "type"),
    subjectId: row["subject_id"] === null ? null : auditText(row, "subject_id"),
    payload: auditPayload(row),
    createdAt: auditText(row, "created_at"),
  };
}

/**
 * 按分支读取时间线上的生命周期审计事件，按时间排序；类型、主体与载荷文本筛选都在 SQL 内完成，
 * 因此 limit 是筛选后的真实条数。
 */
export function listLifecycleTimeline(
  tx: StorageTransaction,
  filter: TimelineFilter,
): readonly ObservedLifecycleEvent[] {
  const direction = filter.order === "desc" ? "DESC" : "ASC";
  const conditions = ["branch_id = ?"];
  const parameters: StorageValue[] = [filter.branchId];
  if (filter.types !== undefined && filter.types.length > 0) {
    conditions.push(`type IN (${filter.types.map(() => "?").join(", ")})`);
    parameters.push(...filter.types);
  }
  if (filter.involving !== undefined) {
    conditions.push(
      `(subject_id = ? OR EXISTS (
          SELECT 1 FROM json_tree(payload_json) AS payload_value
           WHERE payload_value.type = 'text'
             AND INSTR(CAST(payload_value.value AS TEXT), ?) > 0
        ))`,
    );
    parameters.push(filter.involving, filter.involving);
  }
  if (filter.mentioning !== undefined) {
    conditions.push(`EXISTS (
        SELECT 1 FROM json_tree(payload_json) AS payload_value
         WHERE payload_value.type = 'text'
           AND INSTR(CAST(payload_value.value AS TEXT), ?) > 0
      )`);
    parameters.push(filter.mentioning);
  }
  parameters.push(filter.limit);
  return tx.all(
    `SELECT seq, type, subject_id, payload_json, created_at
       FROM lifecycle_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at ${direction}, seq ${direction}
      LIMIT ?`,
    parameters,
  ).map(decodeLifecycleEvent);
}

/**
 * 查找某个 run 与分支内、载荷 operationId 等于给定值的最近一条指定类型审计事件；没有时为 null。
 * operationId 的取值表达式与 lifecycle_debug_operation 索引列逐字一致，查找不随审计量线性增长。
 */
export function latestLifecycleEventByOperation(
  tx: StorageTransaction,
  input: { readonly runId: string; readonly branchId: string; readonly type: string; readonly operationId: string },
): ObservedLifecycleEvent | null {
  const row = tx.get(
    `SELECT seq, type, subject_id, payload_json, created_at FROM lifecycle_events
      WHERE run_id = ? AND branch_id = ? AND type = ?
        AND json_extract(payload_json, '$.operationId') = ?
      ORDER BY seq DESC LIMIT 1`,
    [input.runId, input.branchId, input.type, input.operationId],
  );
  return row === null ? null : decodeLifecycleEvent(row);
}
