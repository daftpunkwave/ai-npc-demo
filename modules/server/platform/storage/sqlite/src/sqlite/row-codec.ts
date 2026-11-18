/**
 * 在存储行与驱动值之间转换：JSON 列用规范 JSON 文本往返，BLOB 保持字节数组，其余列校验为标量。
 * 依赖公共契约的规范 JSON 序列化与存储端口类型，以及迁移推导出的表信息；不解释业务字段含义。
 * 禁止把对象写入非 JSON 列、把字节数组写入 JSON 列，或接受 undefined 与非法数字。
 */
import {
  DomainError,
  canonicalJson,
  type Json,
  type StorageCell,
  type StorageValue,
} from "@ai-npc/contracts";
import type { TableInfo } from "./schema";

function invalidValue(message: string, details: Json): never {
  throw new DomainError("validation", message, { details });
}

function isJsonColumn(table: TableInfo, column: string): boolean {
  return table.jsonColumns.has(column);
}

function parseJsonColumn(table: TableInfo, column: string, text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new DomainError("invalid-state", `存储表 ${table.name} 的 JSON 列 ${column} 内容无法解析`, {
      cause: error,
      details: { table: table.name, column },
    });
  }
}

/** 把驱动返回的一行转换为普通对象并解码 JSON 列；未知列保持原样以暴露目录漂移。 */
export function decodeRow(table: TableInfo, raw: Readonly<Record<string, unknown>>): Readonly<Record<string, StorageCell>> {
  const row: Record<string, StorageCell> = {};
  for (const [column, value] of Object.entries(raw)) {
    row[column] = decodeCell(table, column, value);
  }
  return row;
}

/** 解码单个单元格：JSON 列解析为 JSON 值，BLOB 保持字节数组。 */
export function decodeCell(table: TableInfo, column: string, value: unknown): StorageCell {
  if (value === null || value === undefined) {
    return null;
  }
  if (isJsonColumn(table, column)) {
    if (typeof value !== "string") {
      throw new DomainError("invalid-state", `存储表 ${table.name} 的 JSON 列 ${column} 不是文本`, {
        details: { table: table.name, column },
      });
    }
    return parseJsonColumn(table, column, value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "bigint") {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) {
      invalidValue(`存储列 ${table.name}.${column} 的整数超出安全范围`, { table: table.name, column });
    }
    return numeric;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  throw new DomainError("invalid-state", `存储列 ${table.name}.${column} 返回了不支持的值类型`, {
    details: { table: table.name, column },
  });
}

/** 编码写入值：JSON 列序列化为规范 JSON，布尔映射为 0/1，其他类型按驱动标量校验。 */
export function encodeCell(table: TableInfo, column: string, value: StorageCell | undefined): StorageValue {
  if (value === undefined) {
    invalidValue(`列 ${table.name}.${column} 缺少值，不能写入 undefined`, { table: table.name, column });
  }
  if (value === null) {
    return null;
  }
  if (isJsonColumn(table, column)) {
    if (value instanceof Uint8Array) {
      invalidValue(`JSON 列 ${table.name}.${column} 不能写入字节数组`, { table: table.name, column });
    }
    return canonicalJson(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalidValue(`数值列 ${table.name}.${column} 拒绝 NaN 或 Infinity`, { table: table.name, column });
    }
    return value;
  }
  if (typeof value === "bigint" || typeof value === "string") {
    return value;
  }
  invalidValue(`列 ${table.name}.${column} 只能写入标量或 JSON 值`, { table: table.name, column });
}

/** 编码等值过滤值：JSON 列可传规范文本或 JSON 值；其余列沿用写入编码规则。 */
export function encodeFilterValue(table: TableInfo, column: string, value: StorageValue): StorageValue {
  if (value === null || value instanceof Uint8Array) {
    return value;
  }
  if (isJsonColumn(table, column)) {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "object") {
      return canonicalJson(value as Json);
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

/** 校验列名存在于表目录中，避免把任意标识符拼进 SQL。 */
export function requireColumn(table: TableInfo, column: string): void {
  if (!table.columns.some((candidate) => candidate.name === column)) {
    invalidValue(`表 ${table.name} 没有列 ${column}`, { table: table.name, column });
  }
}
