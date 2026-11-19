/**
 * 发现并按编号顺序执行 migrations/*.sql，把已执行版本写入 schema_migrations。
 * 依赖 node:fs、node:path、node:url 读取迁移文件，node:sqlite 执行 SQL，公共契约的领域错误与日志端口。
 * 禁止跳过缺失或失败迁移、修改已发布迁移文件，或从迁移目录之外加载 SQL。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 迁移目录来自模块常量或测试注入的临时目录，文件名由 readdir 结果按固定正则筛选。 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { DomainError, type HostLogger } from "@ai-npc/contracts";

/** 迁移文件目录：与本模块源码一起交付，不读环境变量或用户目录。 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../migrations/", import.meta.url));

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9-]+)\.sql$/;

/** 一条已加载的迁移：编号、名称、路径与 SQL 正文。 */
export interface StorageMigration {
  readonly version: number;
  readonly name: string;
  readonly filePath: string;
  readonly sql: string;
}

function migrationFailure(message: string, details?: Record<string, string | number>): never {
  throw new DomainError("invalid-state", message, { details: details ?? null });
}

/** 读取迁移目录并按编号排序；要求编号从 1 连续递增且不重复。 */
export function loadMigrations(directory: string = MIGRATIONS_DIRECTORY): readonly StorageMigration[] {
  const names = readdirSync(directory).filter((entry) => MIGRATION_FILE_PATTERN.test(entry));
  const migrations = names.map((fileName) => {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      migrationFailure(`迁移文件名无法解析：${fileName}`);
    }
    const version = Number(match[1]);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 正则已保证分组存在，但仓库开启 noUncheckedIndexedAccess 后索引访问仍可能为 undefined；Codacy 未开启该选项。
    const name = match[2] ?? "";
    const filePath = join(directory, fileName);
    return { version, name, filePath, sql: readFileSync(filePath, "utf8") };
  });
  migrations.sort((left, right) => left.version - right.version);
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected) {
      migrationFailure(
        `迁移编号必须从 1 连续递增：期望 ${expected}，实际 ${migration.version}`,
        { expected, actual: migration.version },
      );
    }
  }
  return migrations;
}

function readAppliedVersions(database: DatabaseSync): readonly number[] {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (table === undefined) {
    return [];
  }
  return database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => Number(row["version"]));
}

/**
 * 执行尚未应用的迁移；每条迁移在自己的写事务内完成，失败时该条整体回滚。
 * 返回本次实际执行的迁移编号，便于宿主记录启动证据。
 */
export function applyMigrations(
  database: DatabaseSync,
  nowIso: string,
  logger: HostLogger,
  directory: string = MIGRATIONS_DIRECTORY,
): readonly number[] {
  const migrations = loadMigrations(directory);
  const applied = readAppliedVersions(database);
  const known = new Set(migrations.map((migration) => migration.version));
  for (const version of applied) {
    if (!known.has(version)) {
      migrationFailure(`数据库已应用迁移 ${version}，但迁移目录中缺少对应文件`, { version });
    }
  }
  const appliedSet = new Set(applied);
  const executed: number[] = [];
  for (const migration of migrations) {
    if (appliedSet.has(migration.version)) {
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, nowIso);
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // 回滚失败没有额外可恢复动作；保留原始迁移错误并向宿主报告。
      }
      throw new DomainError("invalid-state", `迁移 ${migration.version}_${migration.name} 执行失败`, {
        cause: error,
        details: { version: migration.version, name: migration.name },
      });
    }
    executed.push(migration.version);
    logger.info("已应用存储迁移", { version: migration.version, name: migration.name });
  }
  return executed;
}
