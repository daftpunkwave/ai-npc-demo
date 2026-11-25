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

/** 迁移中的表总数：部署级 11 + 分支级 19 + 运行级 12（含运营操作幂等表）。 */
const EXPECTED_TABLE_COUNT = 42;

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
  it("adds conservative immutable frontiers when upgrading existing memory revisions", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const database = openDatabase(join(root, "memory-frontiers.db"));
    try {
      await copyMigrations(migrationsDirectory, host, 13);
      await applyMigrations(database, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      database.prepare("INSERT INTO memory_revisions (branch_id, agent_id, revision, base_revision, observation_seq_through, world_seq_through, change_kind, plan_hash, created_at) VALUES (?, ?, 1, 0, 2, 10, 'ingest', 'fixture', ?)")
        .run("br-000000000001", "human-independent", host.nowIso());
      await copyMigrations(migrationsDirectory, host);
      await applyMigrations(database, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      expect(database.prepare("SELECT revision, observation_seq_through, public_revision, derived_through_seq FROM memory_revisions").get())
        .toMatchObject({ revision: 1, observation_seq_through: 2, public_revision: 0, derived_through_seq: 0 });
    } finally { closeDatabase(database); removeTempDataDir(root); }
  });
  it("首次打开执行全部迁移并记录版本", async () => {
    const harness = await openStorageHarness();
    try {
      const versions = harness.port.transact((tx) =>
        tx.all("SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version"),
      );
      expect(versions.map((row) => row["version"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
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
        expect(versions.map((row) => row["version"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
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

  it("表数量覆盖部署级、分支级与运行级，且死表已被删除", async () => {
    const harness = await openStorageHarness();
    try {
      const tables = readTableNames(harness.port);
      expect(tables).toHaveLength(EXPECTED_TABLE_COUNT);
      // conversation_lines 从未有生产读写方，0010 起不再存在，也不会被分支复制访问。
      expect(tables).not.toContain("conversation_lines");
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

  it("Agent 热路径按活跃集建索引，查询计划不回落到全表扫描", async () => {
    const harness = await openStorageHarness();
    try {
      // 0016 为 triggers、turn_runs 与 maintenance_runs 补索引；
      // 这里的查询形状与 agent-runtime 的实际调用逐字一致，条件改了就应在此失败。
      const plans = harness.port.transact((tx) => ({
        triggers: tx
          .all("EXPLAIN QUERY PLAN SELECT * FROM triggers WHERE branch_id = ? AND consumed_by_turn_id IS NULL ORDER BY rowid", ["br-000000000000"])
          .map((row) => String(row["detail"])),
        recoverExpired: tx
          .all(
            "EXPLAIN QUERY PLAN SELECT * FROM turn_runs WHERE branch_id = ? AND status IN ('queued', 'preparing', 'waiting', 'deciding', 'executing', 'speaking', 'settling') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
            ["br-000000000000", "2026-01-01T00:00:00.000Z"],
          )
          .map((row) => String(row["detail"])),
        due: tx
          .all("EXPLAIN QUERY PLAN SELECT * FROM maintenance_runs WHERE branch_id = ? ORDER BY due_tick ASC, created_at ASC, maintenance_id ASC", ["br-000000000000"])
          .map((row) => String(row["detail"])),
        readiness: tx
          .all("EXPLAIN QUERY PLAN SELECT MAX(due_tick) AS latest_due FROM maintenance_runs WHERE run_id = ? AND agent_id = ? AND due_tick <= ?", ["run-1", "human-independent", 24])
          .map((row) => String(row["detail"])),
      }));

      const flat = Object.values(plans).flat().join("\n");
      expect(flat).not.toContain("SCAN triggers");
      expect(flat).not.toContain("SCAN turn_runs");
      expect(flat).not.toContain("SCAN maintenance_runs");
      expect(plans.triggers.join("\n")).toContain("triggers_pending");
      expect(plans.recoverExpired.join("\n")).toContain("turn_runs_active");
      expect(plans.due.join("\n")).toContain("maintenance_runs_due");
      expect(plans.readiness.join("\n")).toContain("maintenance_runs_run_agent_due");
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
      expect(rows.map((row) => Number(row["version"]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
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

  it("升级重建运营幂等表：既有行保留且 step 种类可写入", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const databasePath = join(root, "legacy-idempotency.db");
    let legacy: ReturnType<typeof openDatabase> | null = null;
    let upgraded: ReturnType<typeof openDatabase> | null = null;
    try {
      // 旧库停留在 step 种类加入之前的版本，并已写入一条既有幂等成功记录。
      await copyMigrations(migrationsDirectory, host, 7);
      legacy = openDatabase(databasePath);
      await applyMigrations(legacy, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      legacy
        .prepare(
          `INSERT INTO operation_idempotency (
             world_id, principal_id, operation_id, operation_kind, request_hash, status,
             result_json, error_code, error_retryable, error_safe_message, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wld-upgrade",
          "player-1",
          "op-000000000001",
          "pause",
          "hash-pause",
          "succeeded",
          JSON.stringify({ worldTick: 0, mode: "paused" }),
          null,
          0,
          null,
          host.nowIso(),
        );
      closeDatabase(legacy);
      legacy = null;

      await copyMigrations(migrationsDirectory, host);
      upgraded = openDatabase(databasePath);
      await applyMigrations(upgraded, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      const preserved = upgraded
        .prepare(
          "SELECT operation_kind, request_hash, status FROM operation_idempotency WHERE operation_id = ?",
        )
        .all("op-000000000001");
      expect(preserved).toEqual([{ operation_kind: "pause", request_hash: "hash-pause", status: "succeeded" }]);
      // 扩展后的 CHECK 允许写入 step 种类；索引随重建表一并恢复。
      upgraded
        .prepare(
          `INSERT INTO operation_idempotency (
             world_id, principal_id, operation_id, operation_kind, request_hash, status,
             result_json, error_code, error_retryable, error_safe_message, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wld-upgrade",
          "console-admin",
          "op-000000000002",
          "step",
          "hash-step",
          "succeeded",
          JSON.stringify({ worldTick: 1, mode: "stepping" }),
          null,
          0,
          null,
          host.nowIso(),
        );
      const kindIndex = upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'operation_idempotency'")
        .all()
        .map((row) => String(row["name"]));
      expect(kindIndex).toContain("operation_idempotency_kind");
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

  it("升级时为已评估 campaign 补建持久时钟停止点", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const databasePath = join(root, "legacy.db");
    let legacy: ReturnType<typeof openDatabase> | null = null;
    let upgraded: ReturnType<typeof openDatabase> | null = null;
    try {
      // 旧库停留在新增停止点表之前的版本，并已写入一个评估完成的 campaign 与暂停时钟。
      await copyMigrations(migrationsDirectory, host, 6);
      legacy = openDatabase(databasePath);
      await applyMigrations(legacy, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      legacy
        .prepare("INSERT INTO worlds (world_id, pack_id, content_version, created_at) VALUES (?, ?, ?, ?)")
        .run("wld-upgrade", "earth-2964-v1", "v1", host.nowIso());
      legacy
        .prepare(
          "INSERT INTO branches (branch_id, world_id, kind, status, parent_branch_id, forked_at_world_seq, run_id, profile_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("brn-upgrade", "wld-upgrade", "online", "active", null, null, null, null, host.nowIso());
      legacy
        .prepare(
          "INSERT INTO aggregate_state (branch_id, aggregate_type, aggregate_id, version, state_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run("brn-upgrade", "campaign", "campaign", 2, JSON.stringify({ status: "evaluated", startTick: 0 }));
      legacy
        .prepare(
          "INSERT INTO clock (branch_id, world_tick, mode, seconds_per_tick, run_version, step_target_tick, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("brn-upgrade", 168, "paused", 20, 3, null, host.nowIso());
      closeDatabase(legacy);
      legacy = null;

      await copyMigrations(migrationsDirectory, host);
      upgraded = openDatabase(databasePath);
      await applyMigrations(upgraded, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      const stops = upgraded
        .prepare("SELECT branch_id, request_id, requested_at_tick FROM clock_stop_requests ORDER BY branch_id")
        .all();
      expect(stops).toEqual([
        { branch_id: "brn-upgrade", request_id: "chapter-evaluated", requested_at_tick: 168 },
      ]);
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
