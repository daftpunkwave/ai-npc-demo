/**
 * 核心职责：把 agent-runtime 所拥有表的存储单元格解码为类型化值，供对外只读查询把行映射为观测记录。
 * 交互契约：同时接受表级接口解码后的行与原始查询行；原始行的 JSON 列是 TEXT，表级行的 JSON 列已解析。
 * 约束与禁忌：不得把缺失、类型不符或无法解析的单元格补成默认值；任何不合法单元格都以 invalid-state 失败，
 *   让控制台读取看到可定位的数据损坏，而不是静默的空结果。
 */
import {
  DomainError,
  jsonValueSchema,
  type Json,
  type StorageRawRow,
  type StorageRow,
} from "@world-prism/contracts";

/** 表级行或原始查询行。 */
export type RuntimeRow = StorageRow | StorageRawRow;

function invalidCell(table: string, column: string, reason: string): never {
  throw new DomainError("invalid-state", `存储表 ${table} 的列 ${column} ${reason}`, {
    details: { table, column },
  });
}

function cellOf(row: RuntimeRow, column: string): unknown {
  // eslint-disable-next-line security/detect-object-injection -- column 来自本包查询的固定列名。
  return row[column];
}

/** 必填非空文本。 */
export function textCell(row: RuntimeRow, table: string, column: string): string {
  const value = cellOf(row, column);
  if (typeof value !== "string" || value.length === 0) invalidCell(table, column, "不是非空文本");
  return value;
}

/** 可空文本。 */
export function nullableTextCell(row: RuntimeRow, table: string, column: string): string | null {
  const value = cellOf(row, column);
  if (value === null) return null;
  if (typeof value !== "string") invalidCell(table, column, "不是文本或 null");
  return value;
}

/** 必填非负安全整数。 */
export function countCell(row: RuntimeRow, table: string, column: string): number {
  const value = cellOf(row, column);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidCell(table, column, "不是非负安全整数");
  }
  return value;
}

/** 可空非负安全整数。 */
export function nullableCountCell(row: RuntimeRow, table: string, column: string): number | null {
  return cellOf(row, column) === null ? null : countCell(row, table, column);
}

/** 必填有限数值。 */
export function finiteCell(row: RuntimeRow, table: string, column: string): number {
  const value = cellOf(row, column);
  if (typeof value !== "number" || !Number.isFinite(value)) invalidCell(table, column, "不是有限数值");
  return value;
}

/** 表级接口已解码的 JSON 列；只复检 JSON 值形状。 */
export function jsonCell(row: StorageRow, table: string, column: string): Json {
  const parsed = jsonValueSchema.safeParse(cellOf(row, column));
  if (!parsed.success) invalidCell(table, column, "不是合法 JSON 值");
  return parsed.data;
}

/** 原始查询返回的 JSON 文本列；SQL NULL 解码为 null。 */
export function jsonTextCell(row: StorageRawRow, table: string, column: string): Json {
  const value = cellOf(row, column);
  if (value === null) return null;
  if (typeof value !== "string") invalidCell(table, column, "不是 JSON 文本");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalidCell(table, column, "不是合法 JSON 文本");
  }
  const json = jsonValueSchema.safeParse(parsed);
  if (!json.success) invalidCell(table, column, "不是合法 JSON 值");
  return json.data;
}

/** 已解码 JSON 值必须是文本数组。 */
export function textArrayOf(value: Json, table: string, column: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidCell(table, column, "不是文本数组");
  }
  return value as readonly string[];
}
