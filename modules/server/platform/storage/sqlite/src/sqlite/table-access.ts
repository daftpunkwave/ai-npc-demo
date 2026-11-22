/**
 * 实现表级读写接口：按主键读写、等值过滤、前缀与排他上界范围查询、排序分页与 JSON 编解码，并强制分支 scope。
 * 依赖 node:sqlite 预编译语句、迁移推导的表目录与行编解码；只接受目录内的表名与列名。
 * 禁止跨分支读写、把调用方字符串拼成 SQL、绕过主键完整性检查或在事务外观测到中间状态。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  type ScopedBranchStorage,
  type StorageFilter,
  type StorageListOptions,
  type StorageRow,
  type StorageTable,
  type StorageValue,
  type StorageWriteResult,
} from "@ai-npc/contracts";
import { decodeRow, encodeCell, encodeFilterValue, requireColumn } from "./row-codec";
import { BRANCH_COLUMN, quoteSqlIdentifier, requireBranchTable, type StorageCatalog, type TableInfo } from "./schema";

function q(identifier: string): string {
  return quoteSqlIdentifier(identifier);
}

function validationFailure(message: string, details: Record<string, string | number>): never {
  throw new DomainError("validation", message, { details });
}

/** 把驱动返回值收敛为端口声明的标量类型；超出安全范围或未知类型直接报错。 */
function toStorageValue(raw: unknown): StorageValue {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (raw instanceof Uint8Array || typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "bigint" || typeof raw === "number") {
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) {
      throw new DomainError("invalid-state", "存储查询返回了超出安全范围的整数");
    }
    return numeric;
  }
  throw new DomainError("invalid-state", "存储查询返回了不支持的标量类型");
}

interface WhereClause {
  readonly clauses: readonly string[];
  readonly params: readonly StorageValue[];
}

/** 前缀查询要求的取值范围：可打印 ASCII（0x20–0x7E）保证字节上界能用合法 UTF-8 字符串表达，末字符码点 +1 与字节进位一致。 */
const PREFIX_PATTERN = /^[\x20-\x7E]*$/;
/** 单张表的读写实现；branchId 为 null 时表示部署级或运行级表。 */
class TableAccess implements StorageTable {
  readonly table: string;
  private readonly database: DatabaseSync;
  private readonly info: TableInfo;
  private readonly branchId: string | null;
  private readonly assertTransactionActive: () => void;

  constructor(
    database: DatabaseSync,
    info: TableInfo,
    branchId: string | null,
    assertTransactionActive: () => void,
  ) {
    this.database = database;
    this.info = info;
    this.table = info.name;
    this.branchId = branchId;
    this.assertTransactionActive = assertTransactionActive;
  }

  /** 分支级表由 scope 注入 branch_id，主键的其余列由调用方给出。 */
  private keyColumns(): readonly string[] {
    return this.branchId === null
      ? this.info.primaryKey
      : this.info.primaryKey.filter((column) => column !== BRANCH_COLUMN);
  }

  private buildWhere(filter: StorageFilter): WhereClause {
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      validationFailure(`表 ${this.table} 的过滤条件必须是对象`, { table: this.table });
    }
    const clauses: string[] = [];
    const params: StorageValue[] = [];
    if (this.branchId !== null) {
      clauses.push(`${q(BRANCH_COLUMN)} = ?`);
      params.push(this.branchId);
    }
    for (const [column, value] of Object.entries(filter)) {
      if (this.branchId !== null && column === BRANCH_COLUMN) {
        validationFailure("分支列由 scope 自动绑定，不能重复指定", { table: this.table, column });
      }
      requireColumn(this.info, column);
      clauses.push(`${q(column)} = ?`);
      params.push(encodeFilterValue(this.info, column, value));
    }
    return { clauses, params };
  }

  private whereSql(where: WhereClause): string {
    return where.clauses.length === 0 ? "" : ` WHERE ${where.clauses.join(" AND ")}`;
  }

  /** 把前缀编译为闭开区间条件 col >= prefix AND col < upper；SQLite 可用主键/索引做范围扫描。 */
  private prefixWhere(prefix: { readonly column: string; readonly value: string }): WhereClause {
    requireColumn(this.info, prefix.column);
    if (!PREFIX_PATTERN.test(prefix.value)) {
      validationFailure("前缀过滤的值必须是可打印 ASCII", { table: this.table, column: prefix.column });
    }
    if (prefix.value.length === 0) {
      return { clauses: [], params: [] };
    }
    const chars = [...prefix.value];
    const last = chars.pop() as string;
    const upper = `${chars.join("")}${String.fromCharCode(last.charCodeAt(0) + 1)}`;
    return {
      clauses: [`${q(prefix.column)} >= ?`, `${q(prefix.column)} < ?`],
      params: [prefix.value, upper],
    };
  }

  /** 把排他上界编译为 col < before；与 prefix 组合表达有界区间，取值约束同前缀。 */
  private beforeWhere(before: { readonly column: string; readonly value: string }): WhereClause {
    requireColumn(this.info, before.column);
    if (!PREFIX_PATTERN.test(before.value)) {
      validationFailure("排他上界的值必须是可打印 ASCII", { table: this.table, column: before.column });
    }
    return {
      clauses: [`${q(before.column)} < ?`],
      params: [before.value],
    };
  }

  private assertKey(key: StorageFilter): void {
    if (typeof key !== "object" || key === null || Array.isArray(key)) {
      validationFailure(`表 ${this.table} 的主键必须是对象`, { table: this.table });
    }
    const expected = this.keyColumns();
    for (const column of Object.keys(key)) {
      if (this.branchId !== null && column === BRANCH_COLUMN) {
        validationFailure("分支列由 scope 自动绑定，不能出现在主键中", { table: this.table, column });
      }
      if (!expected.includes(column)) {
        validationFailure(`列 ${column} 不属于表 ${this.table} 的主键`, { table: this.table, column });
      }
    }
    for (const column of expected) {
      if (!(column in key)) {
        validationFailure(`表 ${this.table} 的主键缺少列 ${column}`, { table: this.table, column });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  get(key: StorageFilter): StorageRow | null {
    this.assertTransactionActive();
    this.assertKey(key);
    const where = this.buildWhere(key);
    const raw = this.database
      .prepare(`SELECT * FROM ${q(this.table)}${this.whereSql(where)} LIMIT 1`)
      .get(...where.params);
    return raw === undefined ? null : decodeRow(this.info, raw as Record<string, unknown>);
  }

  list(filter: StorageFilter = {}, options: StorageListOptions = {}): readonly StorageRow[] {
    this.assertTransactionActive();
    const where = this.buildWhere(filter);
    const prefix = options.prefix === undefined ? null : this.prefixWhere(options.prefix);
    const before = options.before === undefined ? null : this.beforeWhere(options.before);
    const full: WhereClause = {
      clauses: [...where.clauses, ...(prefix?.clauses ?? []), ...(before?.clauses ?? [])],
      params: [...where.params, ...(prefix?.params ?? []), ...(before?.params ?? [])],
    };
    const orderBy = options.orderBy ?? [];
    const orderClauses = orderBy.map((order) => {
      requireColumn(this.info, order.column);
      const direction = order.direction ?? "asc";
      if (direction !== "asc" && direction !== "desc") {
        validationFailure(`排序列 ${order.column} 的方向只能是 asc 或 desc`, {
          table: this.table,
          column: order.column,
        });
      }
      return `${q(order.column)} ${direction === "asc" ? "ASC" : "DESC"}`;
    });
    const params: StorageValue[] = [...full.params];
    const limitClause = this.buildLimitClause(options, params);
    const sql = `SELECT * FROM ${q(this.table)}${this.whereSql(full)}${
      orderClauses.length === 0 ? "" : ` ORDER BY ${orderClauses.join(", ")}`
    }${limitClause}`;
    const rows = this.database.prepare(sql).all(...params);
    return rows.map((row) => decodeRow(this.info, row as Record<string, unknown>));
  }

  private buildLimitClause(options: StorageListOptions, params: StorageValue[]): string {
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
        validationFailure("limit 必须是非负安全整数", { table: this.table });
      }
      params.push(options.limit);
      if (options.offset === undefined) {
        return " LIMIT ?";
      }
      if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
        validationFailure("offset 必须是非负安全整数", { table: this.table });
      }
      params.push(options.offset);
      return " LIMIT ? OFFSET ?";
    }
    if (options.offset !== undefined) {
      if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
        validationFailure("offset 必须是非负安全整数", { table: this.table });
      }
      params.push(options.offset);
      return " LIMIT -1 OFFSET ?";
    }
    return "";
  }

  put(row: StorageRow): StorageWriteResult {
    this.assertTransactionActive();
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      validationFailure(`表 ${this.table} 的写入行必须是对象`, { table: this.table });
    }
    const entries = Object.entries(row);
    for (const [column] of entries) {
      requireColumn(this.info, column);
    }
    if (this.branchId !== null) {
      // eslint-disable-next-line security/detect-object-injection -- 列名来自表结构与本文件的主键清单，索引不来自外部输入。
      const providedBranch = row[BRANCH_COLUMN];
      if (providedBranch !== undefined && providedBranch !== this.branchId) {
        validationFailure("写入行的 branch_id 与 scope 不一致", {
          table: this.table,
          branchId: this.branchId,
        });
      }
    }
    for (const column of this.keyColumns()) {
      // eslint-disable-next-line security/detect-object-injection -- 列名来自表结构与本文件的主键清单，索引不来自外部输入。
      if (!(column in row) || row[column] === undefined) {
        validationFailure(`表 ${this.table} 的写入行缺少主键列 ${column}`, { table: this.table, column });
      }
    }
    const insertColumns = this.info.columns
      .map((column) => column.name)
      .filter((column) => column in row || (this.branchId !== null && column === BRANCH_COLUMN));
    const values: StorageValue[] = [];
    for (const column of insertColumns) {
      if (this.branchId !== null && column === BRANCH_COLUMN) {
        values.push(this.branchId);
        continue;
      }
      // eslint-disable-next-line security/detect-object-injection -- 列名来自表结构与本文件的主键清单，索引不来自外部输入。
      const value = row[column];
      values.push(encodeCell(this.info, column, value));
    }
    const conflictTarget = this.info.primaryKey.map(q).join(", ");
    const updateColumns = insertColumns.filter((column) => !this.info.primaryKey.includes(column));
    const updateSql =
      updateColumns.length === 0
        ? "DO NOTHING"
        : `DO UPDATE SET ${updateColumns.map((column) => `${q(column)} = excluded.${q(column)}`).join(", ")}`;
    const sql = `INSERT INTO ${q(this.table)} (${insertColumns
      .map(q)
      .join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")}) ON CONFLICT (${conflictTarget}) ${updateSql}`;
    const result = this.database.prepare(sql).run(...values);
    return { changes: Number(result.changes) };
  }

  delete(key: StorageFilter): StorageWriteResult {
    this.assertTransactionActive();
    this.assertKey(key);
    const where = this.buildWhere(key);
    const result = this.database
      .prepare(`DELETE FROM ${q(this.table)}${this.whereSql(where)}`)
      .run(...where.params);
    return { changes: Number(result.changes) };
  }

  count(filter: StorageFilter = {}): number {
    this.assertTransactionActive();
    const where = this.buildWhere(filter);
    const row = this.database
      .prepare(`SELECT COUNT(*) AS ${q("total")} FROM ${q(this.table)}${this.whereSql(where)}`)
      .get(...where.params);
    return Number(row?.["total"] ?? 0);
  }

  max(column: string, filter: StorageFilter = {}): StorageValue {
    this.assertTransactionActive();
    requireColumn(this.info, column);
    const where = this.buildWhere(filter);
    const row = this.database
      .prepare(`SELECT MAX(${q(column)}) AS ${q("value")} FROM ${q(this.table)}${this.whereSql(where)}`)
      .get(...where.params);
    return toStorageValue(row?.["value"]);
  }
}

/** 绑定一个分支的 scoped 读写入口：只允许访问分支级表。 */
class BranchAccess implements ScopedBranchStorage {
  readonly branchId: string;
  private readonly database: DatabaseSync;
  private readonly catalog: StorageCatalog;
  private readonly assertTransactionActive: () => void;

  constructor(
    database: DatabaseSync,
    catalog: StorageCatalog,
    branchId: string,
    assertTransactionActive: () => void,
  ) {
    if (branchId.trim().length === 0) {
      validationFailure("branchId 不能为空", { branchId });
    }
    this.database = database;
    this.catalog = catalog;
    this.branchId = branchId;
    this.assertTransactionActive = assertTransactionActive;
  }

  table(name: string): StorageTable {
    this.assertTransactionActive();
    return new TableAccess(
      this.database,
      requireBranchTable(this.catalog, name),
      this.branchId,
      this.assertTransactionActive,
    );
  }
}

/** 为部署级或运行级表构造表读写入口；分支级表会被拒绝。 */
export function createUnscopedTable(
  database: DatabaseSync,
  catalog: StorageCatalog,
  table: TableInfo,
  assertTransactionActive: () => void,
): StorageTable {
  return new TableAccess(database, table, null, assertTransactionActive);
}

/** 为给定分支构造 scoped 读写入口。 */
export function createBranchAccess(
  database: DatabaseSync,
  catalog: StorageCatalog,
  branchId: string,
  assertTransactionActive: () => void,
): ScopedBranchStorage {
  return new BranchAccess(database, catalog, branchId, assertTransactionActive);
}
