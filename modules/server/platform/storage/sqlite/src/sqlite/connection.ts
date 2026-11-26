/**
 * 打开与关闭单写 SQLite 连接，并在打开时应用固定的 PRAGMA 设置。
 * 依赖 node:sqlite 的 DatabaseSync；不读取环境变量、不决定数据目录、不执行迁移。
 * 禁止在此创建第二个写连接、在事务内调用或忽略 PRAGMA 生效失败。
 */
import { DatabaseSync } from "node:sqlite";
import { DomainError } from "@world-prism/contracts";

/** 启动时应用的连接级设置：WAL、NORMAL 同步、外键约束与写锁等待上限。 */
const PRAGMA_STATEMENTS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA foreign_keys = ON;",
  "PRAGMA busy_timeout = 5000;",
] as const;

function readPragmaValue(database: DatabaseSync, name: string): unknown {
  const row = database.prepare(`PRAGMA ${name}`).get();
  if (row === undefined) {
    return undefined;
  }
  return Object.values(row)[0];
}

/** 打开数据库文件并确认关键 PRAGMA 已生效；文件路径由调用方从配置推导。 */
export function openDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  try {
    for (const statement of PRAGMA_STATEMENTS) {
      database.exec(statement);
    }
    const journalMode = readPragmaValue(database, "journal_mode");
    if (journalMode !== "wal") {
      throw new DomainError("invalid-state", "无法启用 SQLite WAL 模式", {
        details: { journalMode: typeof journalMode === "string" ? journalMode : null },
      });
    }
    if (readPragmaValue(database, "foreign_keys") !== 1) {
      throw new DomainError("invalid-state", "无法启用 SQLite 外键约束");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** 关闭连接；关闭失败不掩盖调用方已有的错误，由调用方记录。 */
export function closeDatabase(database: DatabaseSync): void {
  database.close();
}
