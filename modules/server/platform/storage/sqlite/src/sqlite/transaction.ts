/**
 * 事务内存储视图：原始查询、表级 scope 访问与 SAVEPOINT，并拒绝返回 Promise 的回调。
 * 依赖 node:sqlite 预编译语句、迁移推导的表目录、表读写实现与端口契约。
 * 禁止在事务结束后继续使用、执行嵌套 BEGIN、暴露连接或忽略保存点回滚失败。
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  DomainError,
  type ScopedBranchStorage,
  type StorageRawRow,
  type StorageTable,
  type StorageTransaction,
  type StorageValue,
  type StorageWriteResult,
} from "@ai-npc/contracts";
import { requireUnscopedTable, type StorageCatalog } from "./schema";
import { createBranchAccess, createUnscopedTable } from "./table-access";

const SAVEPOINT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** 仓库内的同步事务约定：回调返回 Promise 视为编程错误，必须回滚并拒绝。 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof (value as { readonly then?: unknown }).then === "function";
}

function toRawRow(raw: Readonly<Record<string, unknown>>): StorageRawRow {
  const row: Record<string, StorageValue> = {};
  for (const [column, value] of Object.entries(raw)) {
    if (value === null || value === undefined) {
      // eslint-disable-next-line security/detect-object-injection -- 列名来自 Object.entries 的既有行数据，索引不来自外部输入。
      row[column] = null;
    } else if (value instanceof Uint8Array || typeof value === "string" || typeof value === "number") {
      // eslint-disable-next-line security/detect-object-injection -- 列名来自 Object.entries 的既有行数据，索引不来自外部输入。
      row[column] = value;
    } else if (typeof value === "bigint") {
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric)) {
        throw new DomainError("invalid-state", "存储查询返回了超出安全范围的整数", {
          details: { column },
        });
      }
      // eslint-disable-next-line security/detect-object-injection -- 列名来自 Object.entries 的既有行数据，索引不来自外部输入。
      row[column] = numeric;
    } else {
      throw new DomainError("invalid-state", "存储查询返回了不支持的标量类型", {
        details: { column },
      });
    }
  }
  return row;
}

/** 一个同步事务内的存储视图；close() 之后任何访问都会失败。 */
export class SqliteTransaction implements StorageTransaction {
  private readonly database: DatabaseSync;
  private readonly catalog: StorageCatalog;
  private readonly statements = new Map<string, StatementSync>();
  private active = true;

  constructor(database: DatabaseSync, catalog: StorageCatalog) {
    this.database = database;
    this.catalog = catalog;
  }

  /** 由事务包装器在提交或回滚后调用；重复调用安全。 */
  close(): void {
    this.active = false;
    this.statements.clear();
  }

  /** 事务是否仍可访问；分支复制等跨模块操作用它拒绝已结束的事务对象。 */
  get isOpen(): boolean {
    return this.active;
  }

  private assertActive(): void {
    if (!this.active) {
      throw new DomainError("invalid-state", "存储事务已结束，不能再使用该事务对象");
    }
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const prepared = this.database.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
  get(sql: string, params: readonly StorageValue[] = []): StorageRawRow | null {
    this.assertActive();
    const raw = this.statement(sql).get(...params);
    return raw === undefined ? null : toRawRow(raw as Record<string, unknown>);
  }

  all(sql: string, params: readonly StorageValue[] = []): readonly StorageRawRow[] {
    this.assertActive();
    const rows = this.statement(sql).all(...params);
    return rows.map((row) => toRawRow(row as Record<string, unknown>));
  }

  run(sql: string, params: readonly StorageValue[] = []): StorageWriteResult {
    this.assertActive();
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  rows(table: string): StorageTable {
    this.assertActive();
    return createUnscopedTable(
      this.database,
      this.catalog,
      requireUnscopedTable(this.catalog, table),
      () => this.assertActive(),
    );
  }

  branch(branchId: string): ScopedBranchStorage {
    this.assertActive();
    return createBranchAccess(this.database, this.catalog, branchId, () => this.assertActive());
  }

  savepoint<T>(name: string, fn: () => T): T {
    this.assertActive();
    if (!SAVEPOINT_NAME_PATTERN.test(name)) {
      throw new DomainError("validation", `保存点名称不合法：${name}`, { details: { name } });
    }
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      if (isThenable(result)) {
        (result as PromiseLike<unknown>).then(undefined, () => {
          // 同步事务内的异步回调属于编程错误：拒绝该结果，异步后续失败不再向上抛出。
        });
        throw new DomainError("invalid-state", "存储事务回调必须是同步函数，不能返回 Promise", {
          details: { savepoint: name },
        });
      }
      this.database.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.database.exec(`RELEASE SAVEPOINT ${name}`);
      } catch (rollbackError) {
        throw new DomainError("invalid-state", "保存点回滚失败，事务状态不再可信", {
          cause: { rollbackError, originalError: error },
          details: { savepoint: name },
        });
      }
      throw error;
    }
  }
}
