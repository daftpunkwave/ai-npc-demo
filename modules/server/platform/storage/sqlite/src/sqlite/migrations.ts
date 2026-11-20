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
import { DomainError, type HostLogger, type HostServices, type Json } from "@ai-npc/contracts";

/** 迁移文件目录：与本模块源码一起交付，不读环境变量或用户目录。 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** 校验和功能上线前已发布迁移的固定内容指纹。 */
const PUBLISHED_MIGRATION_CHECKSUMS: Readonly<Record<number, string>> = {
  1: "094af55f72d0e55734d543297bdc094f73167714b6ba0b37202a067706cd5529",
  2: "0952dd9b3492bd09bdbd345393bdc2b8576d26affbfa3b52fd62090963f9487e",
  3: "69297c06204b3a8fa24a7573fe2fc086b54bc59b19e27157a45fadb6711c0932",
};

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9-]+)\.sql$/;

/** 一条已加载的迁移：编号、名称、路径与 SQL 正文。 */
export interface StorageMigration {
  readonly version: number;
  readonly name: string;
  readonly filePath: string;
  readonly sql: string;
  readonly checksum: string;
}

type MigrationHasher = HostServices["hash"];

function migrationFailure(message: string, details?: Record<string, string | number>): never {
  throw new DomainError("invalid-state", message, { details: details ?? null });
}

function normalizeMigrationSql(sql: string): string {
  return sql.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** 读取迁移目录并按编号排序；要求编号从 1 连续递增且不重复。 */
export async function loadMigrations(
  hash: MigrationHasher,
  directory: string = MIGRATIONS_DIRECTORY,
): Promise<readonly StorageMigration[]> {
  const names = readdirSync(directory).filter((entry) => MIGRATION_FILE_PATTERN.test(entry));
  const migrations = await Promise.all(names.map(async (fileName) => {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      migrationFailure(`迁移文件名无法解析：${fileName}`);
    }
    const version = Number(match[1]);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 正则已保证分组存在，但仓库开启 noUncheckedIndexedAccess 后索引访问仍可能为 undefined；Codacy 未开启该选项。
    const name = match[2] ?? "";
    const filePath = join(directory, fileName);
    const sql = normalizeMigrationSql(readFileSync(filePath, "utf8"));
    const checksum = await hash(sql as Json);
    return { version, name, filePath, sql, checksum };
  }));
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

interface AppliedMigration {
  readonly version: number;
  readonly checksum: string | null;
}

function hasChecksumColumn(database: DatabaseSync): boolean {
  const column = database
    .prepare(
      "SELECT name FROM pragma_table_info('schema_migrations') WHERE name = 'checksum'",
    )
    .get();
  return column !== undefined;
}

function readAppliedMigrations(database: DatabaseSync): readonly AppliedMigration[] {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (table === undefined) {
    return [];
  }
  const checksumExpression = hasChecksumColumn(database) ? "checksum" : "NULL AS checksum";
  return database
    .prepare(`SELECT version, ${checksumExpression} FROM schema_migrations ORDER BY version`)
    .all()
    .map((row) => ({
      version: Number(row["version"]),
      checksum: row["checksum"] === null ? null : String(row["checksum"]),
    }));
}

function insertAppliedMigration(
  database: DatabaseSync,
  migration: StorageMigration,
  nowIso: string,
): void {
  if (hasChecksumColumn(database)) {
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)")
      .run(migration.version, nowIso, migration.checksum);
    return;
  }
  database
    .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(migration.version, nowIso);
}

function assertAppliedChecksums(
  database: DatabaseSync,
  migrations: readonly StorageMigration[],
): void {
  if (!hasChecksumColumn(database)) {
    return;
  }
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const applied of readAppliedMigrations(database)) {
    const migration = byVersion.get(applied.version);
    if (migration === undefined) {
      continue;
    }
    if (applied.checksum === null || applied.checksum.length === 0) {
      migrationFailure(`数据库已应用迁移 ${applied.version}，但缺少内容校验和`, {
        version: applied.version,
      });
    }
    if (applied.checksum !== migration.checksum) {
      migrationFailure(`数据库已应用迁移 ${applied.version} 的内容校验和不一致`, {
        version: applied.version,
        expected: migration.checksum,
        actual: applied.checksum,
      });
    }
  }
}

function assertLegacyPublishedChecksums(
  database: DatabaseSync,
  migrations: readonly StorageMigration[],
  applied: readonly AppliedMigration[],
): void {
  if (hasChecksumColumn(database)) {
    return;
  }
  const appliedVersions = new Set(applied.map((migration) => migration.version));
  for (const migration of migrations) {
    const expected = PUBLISHED_MIGRATION_CHECKSUMS[migration.version];
    if (expected !== undefined && appliedVersions.has(migration.version) && migration.checksum !== expected) {
      migrationFailure(`数据库已应用迁移 ${migration.version} 的内容校验和不一致`, {
        version: migration.version,
        expected,
        actual: migration.checksum,
      });
    }
  }
}

/**
 * 执行尚未应用的迁移；每条迁移在自己的写事务内完成，失败时该条整体回滚。
 * 返回本次实际执行的迁移编号，便于宿主记录启动证据。
 */
export async function applyMigrations(
  database: DatabaseSync,
  nowIso: string,
  logger: HostLogger,
  hash: MigrationHasher,
  directory: string = MIGRATIONS_DIRECTORY,
): Promise<readonly number[]> {
  const migrations = await loadMigrations(hash, directory);
  const applied = readAppliedMigrations(database);
  const known = new Set(migrations.map((migration) => migration.version));
  for (const version of applied) {
    if (!known.has(version.version)) {
      migrationFailure(`数据库已应用迁移 ${version.version}，但迁移目录中缺少对应文件`, {
        version: version.version,
      });
    }
  }
  if (hasChecksumColumn(database)) {
    assertAppliedChecksums(database, migrations);
  } else {
    assertLegacyPublishedChecksums(database, migrations, applied);
  }
  const appliedSet = new Set(applied.map((migration) => migration.version));
  const executed: number[] = [];
  for (const migration of migrations) {
    if (appliedSet.has(migration.version)) {
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      insertAppliedMigration(database, migration, nowIso);
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
  assertAppliedChecksums(database, migrations);
  return executed;
}
