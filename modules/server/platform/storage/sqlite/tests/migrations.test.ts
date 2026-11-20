/**
 * 验证迁移与表目录：表数量、版本记录、重复打开幂等、PRAGMA 生效、job 推进索引、分支级表清单与运营幂等表部署级身份。
 * 依赖存储模块测试助手与迁移推导的分支级表常量。
 * 禁止连接真实数据库文件、跳过失败迁移断言或把运行级表当作分支级表。
 */
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { StoragePort } from "@ai-npc/contracts";
import { BRANCH_TABLES, OPERATION_IDEMPOTENCY_TABLE } from "../src/sqlite/schema";
import { closeDatabase, openDatabase } from "../src/sqlite/connection";
import {
  applyMigrations,
  loadMigrations,
  MIGRATIONS_DIRECTORY,
} from "../src/sqlite/migrations";
import {
  createFakeHost,
  createTempDataDir,
  openStorageHarness,
  removeTempDataDir,
  startStorage,
} from "./support";

/** 迁移中的表总数：部署级 10 + 分支级 18 + 运行级 12（含运营操作幂等表）。 */
const EXPECTED_TABLE_COUNT = 40;

function readTableNames(port: StoragePort): readonly string[] {
  return port.transact((tx) =>
    tx
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((row) => String(row["name"])),
  );
}

/** 从迁移推导分支级表：主键包含 branch_id，且排除登记分支本身的 branches 表。 */
function deriveBranchTables(port: StoragePort): readonly string[] {
  const names = readTableNames(port);
  return port.transact((tx) =>
    names.filter((name) => {
      if (name === "branches") {
        return false;
      }
      const row = tx.get(
        "SELECT COUNT(*) AS total FROM pragma_table_info(?) WHERE pk > 0 AND name = 'branch_id'",
        [name],
      );
      return Number(row?.["total"] ?? 0) > 0;
    }),
  );
}

async function copyMigrations(
  targetDirectory: string,
  host: ReturnType<typeof createFakeHost>,
  maxVersion = Number.POSITIVE_INFINITY,
): Promise<void> {
  const migrations = await loadMigrations(host.hash, MIGRATIONS_DIRECTORY);
  for (const migration of migrations) {
    if (migration.version <= maxVersion) {
      writeFileSync(join(targetDirectory, basename(migration.filePath)), migration.sql, "utf8");
    }
  }
}

describe("初始迁移", () => {
  it("首次打开执行全部迁移并记录版本", async () => {
    const harness = await openStorageHarness();
    try {
      const versions = harness.port.transact((tx) =>
        tx.all("SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version"),
      );
      expect(versions.map((row) => row["version"])).toEqual([1, 2, 3, 4, 5]);
      for (const version of versions) {
        expect(typeof version["applied_at"]).toBe("string");
        expect(version["checksum"]).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(harness.host.logs.some((log) => log.message === "已应用存储迁移")).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("重复打开不重复执行迁移", async () => {
    const dataDir = createTempDataDir();
    try {
      const first = await startStorage(dataDir);
      await first.dispose();
      const second = await startStorage(dataDir);
      try {
        const versions = second.port.transact((tx) => tx.all("SELECT version FROM schema_migrations ORDER BY version"));
        expect(versions.map((row) => row["version"])).toEqual([1, 2, 3, 4, 5]);
        expect(second.host.logs.some((log) => log.message === "已应用存储迁移")).toBe(false);
      } finally {
        await second.dispose();
      }
    } finally {
      removeTempDataDir(dataDir);
    }
  });

  it("分支级表清单与迁移一致", async () => {
    const harness = await openStorageHarness();
    try {
      expect(deriveBranchTables(harness.port)).toEqual([...BRANCH_TABLES].sort());
    } finally {
      await harness.dispose();
    }
  });

  it("表数量覆盖部署级、分支级与运行级", async () => {
    const harness = await openStorageHarness();
    try {
      expect(readTableNames(harness.port)).toHaveLength(EXPECTED_TABLE_COUNT);
    } finally {
      await harness.dispose();
    }
  });

  it("运营幂等表是部署级表，不参与分支复制", async () => {
    const harness = await openStorageHarness();
    try {
      const columns = harness.port
        .transact((tx) =>
          tx.all(`SELECT name FROM pragma_table_info('${OPERATION_IDEMPOTENCY_TABLE}')`),
        )
        .map((row) => String(row["name"]));
      expect(columns).toContain("request_hash");
      expect(columns).toContain("result_json");
      expect(columns).not.toContain("branch_id");
      expect(deriveBranchTables(harness.port)).not.toContain(OPERATION_IDEMPOTENCY_TABLE);
    } finally {
      await harness.dispose();
    }
  });

  it("job 推进使用 scheduled 部分索引，按 (status, due_tick, seq) 取最早候选", async () => {
    const harness = await openStorageHarness();
    try {
      // 0003 用只含 scheduled 行的部分索引替换 0001 的全状态索引，避免已完成历史行扩大索引。
      const indexes = harness.port.transact((tx) =>
        tx.all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' ORDER BY name"),
      );
      const index = indexes.find((row) => row["name"] === "jobs_status_due_seq");
      expect(index).toBeDefined();
      expect(String(index?.["sql"])).toContain("WHERE status = 'scheduled'");
      expect(indexes.map((row) => row["name"])).not.toContain("jobs_due");

      const columns = harness.port
        .transact((tx) => tx.all("SELECT name FROM pragma_index_info('jobs_status_due_seq') ORDER BY seqno"))
        .map((row) => String(row["name"]));
      expect(columns).toEqual(["branch_id", "status", "due_tick", "seq"]);

      // 与 JobRunner 完全相同的查询形状；计划必须是索引查找而不是全表扫描。
      const plan = harness.port
        .transact((tx) =>
          tx.all(
            "EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE branch_id = ? AND status = ? ORDER BY due_tick ASC, seq ASC LIMIT 1",
            ["br-000000000000", "scheduled"],
          ),
        )
        .map((row) => String(row["detail"]))
        .join("\n");
      expect(plan).toContain("jobs_status_due_seq");
      expect(plan).not.toContain("SCAN jobs");
    } finally {
      await harness.dispose();
    }
  });

  it("打开后 WAL 与外键 PRAGMA 生效", async () => {
    const harness = await openStorageHarness();
    try {
      const pragmas = harness.port.transact((tx) => ({
        journalMode: tx.get("PRAGMA journal_mode")?.["journal_mode"],
        foreignKeys: tx.get("PRAGMA foreign_keys")?.["foreign_keys"],
      }));
      expect(pragmas.journalMode).toBe("wal");
      expect(pragmas.foreignKeys).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});

describe("迁移校验和", () => {
  it("refuses to start when an applied migration file changes", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const databasePath = join(root, "checksum.db");
    let first: ReturnType<typeof openDatabase> | null = null;
    let second: ReturnType<typeof openDatabase> | null = null;
    try {
      await copyMigrations(migrationsDirectory, host);
      first = openDatabase(databasePath);
      await applyMigrations(first, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      closeDatabase(first);
      first = null;

      appendFileSync(join(migrationsDirectory, "0002_operation-idempotency.sql"), "\n-- 改动已应用迁移\n", "utf8");
      second = openDatabase(databasePath);
      await expect(
        applyMigrations(second, host.nowIso(), host.logger, host.hash, migrationsDirectory),
      ).rejects.toMatchObject({
        code: "invalid-state",
        details: { version: 2 },
      });
    } finally {
      if (first !== null) {
        closeDatabase(first);
      }
      if (second !== null) {
        closeDatabase(second);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to upgrade a legacy database when a published migration changes", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const databasePath = join(root, "legacy-changed.db");
    let legacy: ReturnType<typeof openDatabase> | null = null;
    let upgraded: ReturnType<typeof openDatabase> | null = null;
    try {
      await copyMigrations(migrationsDirectory, host, 3);
      legacy = openDatabase(databasePath);
      await applyMigrations(legacy, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      closeDatabase(legacy);
      legacy = null;

      await copyMigrations(migrationsDirectory, host);
      appendFileSync(
        join(migrationsDirectory, "0002_operation-idempotency.sql"),
        "\n-- 升级前改动已发布迁移\n",
        "utf8",
      );
      upgraded = openDatabase(databasePath);
      await expect(
        applyMigrations(upgraded, host.nowIso(), host.logger, host.hash, migrationsDirectory),
      ).rejects.toMatchObject({
        code: "invalid-state",
        details: { version: 2 },
      });
      const columns = upgraded
        .prepare("SELECT name FROM pragma_table_info('schema_migrations')")
        .all()
        .map((row) => String(row["name"]));
      expect(columns).not.toContain("checksum");
      expect(
        upgraded
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => Number(row["version"])),
      ).toEqual([1, 2, 3]);
    } finally {
      if (legacy !== null) {
        closeDatabase(legacy);
      }
      if (upgraded !== null) {
        closeDatabase(upgraded);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backfills checksums when upgrading a database created before checksum tracking", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const databasePath = join(root, "legacy.db");
    let legacy: ReturnType<typeof openDatabase> | null = null;
    let upgraded: ReturnType<typeof openDatabase> | null = null;
    try {
      await copyMigrations(migrationsDirectory, host, 3);
      legacy = openDatabase(databasePath);
      await applyMigrations(legacy, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      closeDatabase(legacy);
      legacy = null;

      await copyMigrations(migrationsDirectory, host);
      upgraded = openDatabase(databasePath);
      await applyMigrations(upgraded, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      const rows = upgraded
        .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
        .all();
      expect(rows.map((row) => Number(row["version"]))).toEqual([1, 2, 3, 4, 5]);
      expect(rows.every((row) => /^[a-f0-9]{64}$/.test(String(row["checksum"])))).toBe(true);
      closeDatabase(upgraded);
      upgraded = null;
    } finally {
      if (legacy !== null) {
        closeDatabase(legacy);
      }
      if (upgraded !== null) {
        closeDatabase(upgraded);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
