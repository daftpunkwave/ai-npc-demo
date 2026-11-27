/**
 * 读取存储行的标量与 JSON 单元格，并把宿主同步约定收敛为可复用的检查。
 * 依赖公共契约的 JSON schema、存储行类型与领域错误；不解释业务字段含义。
 * 禁止把类型不明或非有限数值静默转为业务值，也禁止把 Promise 当作同步结果继续执行。
 */
import {
  DomainError,
  jsonValueSchema,
  type Json,
  type StorageRawRow,
  type StorageRow,
} from "@world-prism/contracts";

/** 表级接口解码后的行或原始查询行；标量列在两者中形态相同。 */
type StorageRecord = StorageRow | StorageRawRow;

function invalidRow(table: string, column: string, reason: string): never {
  throw new DomainError("invalid-state", `存储表 ${table} 的列 ${column} ${reason}`, {
    details: { table, column },
  });
}

/** 读取一列；列名由本文件的固定辅助函数传入，不接受任意外部键。 */
function cellOf(row: StorageRecord, column: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- column 由固定调用点提供，row 来自已解码存储行。
  return row[column];
}

/** 读取必填整数列；负数、非安全整数或非数字都在此失败。 */
export function requireStorageNumber(row: StorageRecord, table: string, column: string): number {
  const value = cellOf(row, column);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidRow(table, column, "不是非负安全整数");
  }
  return value;
}

/** 读取必填字符串列；空字符串视为损坏数据。 */
export function requireStorageString(row: StorageRecord, table: string, column: string): string {
  const value = cellOf(row, column);
  if (typeof value !== "string" || value.length === 0) {
    invalidRow(table, column, "不是非空字符串");
  }
  return value;
}

/** 读取可空字符串列；未提供时返回 null。 */
export function optionalStorageString(row: StorageRecord, table: string, column: string): string | null {
  const value = cellOf(row, column);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    invalidRow(table, column, "不是字符串或 null");
  }
  return value;
}

/** 读取可空整数列；未提供时返回 null。 */
export function optionalStorageNumber(row: StorageRecord, table: string, column: string): number | null {
  const value = cellOf(row, column);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidRow(table, column, "不是非负安全整数或 null");
  }
  return value;
}

/** 读取 JSON 列；表级接口已解码，这里只做 JSON 值形状复检。 */
export function readJsonCell(cell: unknown, table: string, column: string): Json {
  if (cell === undefined) {
    invalidRow(table, column, "缺失");
  }
  const parsed = jsonValueSchema.safeParse(cell);
  if (!parsed.success) {
    invalidRow(table, column, "不是合法 JSON 值");
  }
  return parsed.data;
}

/** 读取原始查询返回的 JSON 文本列：原始查询绕过表级接口的解码，文本须在这里解析并复检形状。 */
export function readJsonTextCell(cell: unknown, table: string, column: string): Json {
  if (typeof cell !== "string") {
    invalidRow(table, column, "不是 JSON 文本");
  }
  let value: unknown;
  try {
    value = JSON.parse(cell);
  } catch {
    invalidRow(table, column, "不是合法 JSON 文本");
  }
  return readJsonCell(value, table, column);
}

/** 检测处理器是否意外返回 Promise；同步事务内不得等待。 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
