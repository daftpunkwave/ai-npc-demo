/**
 * 验证迁移与表目录：表数量、版本记录、重复打开幂等、PRAGMA 生效、job 推进索引、分支级表清单与运营幂等表部署级身份。
 * 依赖存储模块测试助手与迁移推导的分支级表常量。
 * 禁止连接真实数据库文件、跳过失败迁移断言或把运行级表当作分支级表。
 */
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { StoragePort } from "@world-prism/contracts";
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
  type StorageHandle,
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
      expect(versions.map((row) => row["version"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
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
        expect(versions.map((row) => row["version"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
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

  it("Agent 热路径索引按活跃集收录，索引规模不随历史增长", async () => {
    const harness = await openStorageHarness();
    try {
      // 这里只断言索引本身的定义；查询是否真的命中由 agent-runtime 侧用生产 SQL 断言，
      // 因为参数化写法会让 SQLite 放弃部分索引，字面量副本的查询计划说明不了生产行为。
      const indexes = harness.port.transact((tx) =>
        tx.all(
          "SELECT tbl_name, name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('triggers', 'turn_runs', 'maintenance_runs') ORDER BY name",
        ),
      );
      const byName = new Map(indexes.map((row) => [String(row["name"]), String(row["sql"])]));

      expect(byName.get("triggers_pending")).toContain("WHERE consumed_by_turn_id IS NULL");
      expect(byName.get("turn_runs_active")).toContain("WHERE status IN ('queued', 'preparing', 'waiting', 'deciding', 'executing', 'speaking', 'settling')");
      expect(byName.get("maintenance_runs_due")).toContain("due_tick");
      expect(byName.get("maintenance_runs_run_agent_due")).toContain("run_id, agent_id, due_tick");
      expect(byName.get("maintenance_runs_task")).toContain("trigger, due_tick");
    } finally {
      await harness.dispose();
    }
  });

  it("最近一次 DayPassed 查询命中表达式部分索引", async () => {
    const harness = await openStorageHarness();
    try {
      // 0017 用表达式部分索引把范围限定在 DayPassed 行；
      // 查询形状与 MemoryStore.latestDayPassed 逐字一致，条件改了就应在此失败。
      const plan = harness.port
        .transact((tx) =>
          tx.all(
            "EXPLAIN QUERY PLAN SELECT known_at_tick, observation_seq FROM observations WHERE branch_id = ? AND agent_id = ? AND json_extract(content_json, '$.eventType') = 'DayPassed' ORDER BY known_at_tick DESC, observation_seq DESC LIMIT 1",
            ["br-000000000000", "human-independent"],
          ),
        )
        .map((row) => String(row["detail"]))
        .join("\n");
      expect(plan).toContain("observations_day_passed");
      expect(plan).not.toContain("SCAN observations");
      expect(plan).not.toContain("USE TEMP B-TREE");
    } finally {
      await harness.dispose();
    }
  });

  it("工具调用的配额计数与结果查找命中 0018 的覆盖索引", async () => {
    const harness = await openStorageHarness();
    try {
      // 0018 为 tool_calls 补 (run_id, turn_id, tool_id) 与
      // (run_id, turn_id, attempt_id, provider_call_id, created_at) 两个索引；
      // 两个查询形状分别对应 tool-gateway 的配额计数与 tool-outcome-store 的首行查找。
      const planOf = (sql: string, params: readonly string[]): string =>
        harness.port
          .transact((tx) => tx.all(`EXPLAIN QUERY PLAN ${sql}`, params))
          .map((row) => String(row["detail"]))
          .join("\n");

      const quota = planOf(
        "SELECT COUNT(*) AS total FROM tool_calls WHERE run_id = ? AND turn_id = ? AND tool_id = ?",
        ["run-000000000001", "turn-000000000001", "message.send"],
      );
      expect(quota).toContain("tool_calls_turn_tool");
      expect(quota).not.toContain("SCAN tool_calls");

      const outcome = planOf(
        "SELECT * FROM tool_calls WHERE run_id = ? AND turn_id = ? AND attempt_id = ? AND provider_call_id = ? ORDER BY created_at ASC",
        ["run-000000000001", "turn-000000000001", "att-000000000001", "call-000000000001"],
      );
      expect(outcome).toContain("tool_calls_attempt_call");
      expect(outcome).not.toContain("SCAN tool_calls");
      expect(outcome).not.toContain("USE TEMP B-TREE");
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
      expect(rows.map((row) => Number(row["version"]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
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

  it("升级重建运营幂等表：既有行保留且名册休眠与唤醒种类可写入", async () => {
    const root = createTempDataDir();
    const migrationsDirectory = join(root, "migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    const databasePath = join(root, "legacy-roster-idempotency.db");
    let legacy: ReturnType<typeof openDatabase> | null = null;
    let upgraded: ReturnType<typeof openDatabase> | null = null;
    const insert = `INSERT INTO operation_idempotency (
         world_id, principal_id, operation_id, operation_kind, request_hash, status,
         result_json, error_code, error_retryable, error_safe_message, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    try {
      // 旧库停留在名册种类加入之前的版本：既有 step 记录必须原样保留，新种类在旧约束下被拒绝。
      await copyMigrations(migrationsDirectory, host, 20);
      legacy = openDatabase(databasePath);
      await applyMigrations(legacy, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      legacy.prepare(insert).run(
        "wld-upgrade", "console-admin", "op-000000000001", "step", "hash-step", "failed",
        null, "invalid-state", 1, "时钟控制参数非法", host.nowIso(),
      );
      const legacyDatabase = legacy;
      expect(() => legacyDatabase.prepare(insert).run(
        "wld-upgrade", "console-admin", "op-000000000002", "hibernate", "hash-hibernate", "succeeded",
        "{}", null, 0, null, host.nowIso(),
      )).toThrow();
      closeDatabase(legacy);
      legacy = null;

      await copyMigrations(migrationsDirectory, host);
      upgraded = openDatabase(databasePath);
      await applyMigrations(upgraded, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      expect(upgraded
        .prepare("SELECT operation_kind, request_hash, status, error_retryable, error_safe_message FROM operation_idempotency")
        .all()).toEqual([{
        operation_kind: "step", request_hash: "hash-step", status: "failed", error_retryable: 1, error_safe_message: "时钟控制参数非法",
      }]);
      for (const [operationId, kind] of [["op-000000000002", "hibernate"], ["op-000000000003", "wake"]] as const) {
        upgraded.prepare(insert).run(
          "wld-upgrade", "console-admin", operationId, kind, `hash-${kind}`, "succeeded", "{}", null, 0, null, host.nowIso(),
        );
      }
      expect(upgraded
        .prepare("SELECT operation_kind FROM operation_idempotency ORDER BY operation_id")
        .all()
        .map((row) => row["operation_kind"])).toEqual(["step", "hibernate", "wake"]);
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

  it("升级重建控制租约表：既有快照与在线分支的租约保留、可继续复制，script 种类可写入", async () => {
    const dataDir = createTempDataDir();
    const migrationsDirectory = join(dataDir, "legacy-migrations");
    mkdirSync(migrationsDirectory);
    const host = createFakeHost();
    let legacy: ReturnType<typeof openDatabase> | null = null;
    let upgraded: StorageHandle | null = null;
    try {
      // 旧库停留在 script 种类加入之前的版本：一个在线分支与一个冻结快照，各有 Agent 与真人控制的租约。
      await copyMigrations(migrationsDirectory, host, 20);
      legacy = openDatabase(join(dataDir, "world-prism.db"));
      await applyMigrations(legacy, host.nowIso(), host.logger, host.hash, migrationsDirectory);
      legacy
        .prepare("INSERT INTO worlds (world_id, pack_id, content_version, created_at) VALUES (?, ?, ?, ?)")
        .run("wld-upgrade", "earth-2964-v1", "v1", host.nowIso());
      const insertBranch = legacy.prepare(
        "INSERT INTO branches (branch_id, world_id, kind, status, parent_branch_id, forked_at_world_seq, run_id, profile_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      insertBranch.run("br-online", "wld-upgrade", "online", "active", null, null, "run-online", null, host.nowIso());
      insertBranch.run("br-snapshot", "wld-upgrade", "snapshot", "frozen", "br-online", 0, null, null, host.nowIso());
      const insertLease = legacy.prepare(
        "INSERT INTO controller_leases (branch_id, agent_id, controller_kind, controller_principal_id, controller_epoch, lease_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const branchId of ["br-online", "br-snapshot"]) {
        insertLease.run(branchId, "human-independent", "agent", null, 3, null);
        insertLease.run(branchId, "species-fauna", "human", "operator-1", 2, "2026-01-01T00:10:00.000Z");
      }
      expect(() => insertLease.run("br-online", "human-pacifist", "script", "run-online", 1, null)).toThrow();
      closeDatabase(legacy);
      legacy = null;

      upgraded = await startStorage(dataDir, host);
      const port = upgraded.port;
      const leases = (branchId: string) => port.transact((tx) => tx.branch(branchId).table("controller_leases")
        .list({}, { orderBy: [{ column: "agent_id" }] })
        .map((row) => [row["agent_id"], row["controller_kind"], row["controller_principal_id"], row["controller_epoch"], row["lease_expires_at"]]));
      const legacyRows = [
        ["human-independent", "agent", null, 3, null],
        ["species-fauna", "human", "operator-1", 2, "2026-01-01T00:10:00.000Z"],
      ];
      expect(leases("br-online")).toEqual(legacyRows);
      expect(leases("br-snapshot")).toEqual(legacyRows);
      // 既有快照仍可复制出新分支：列清单不变，代次照常递增。
      port.transact((tx) => port.forkBranch(tx, { srcBranchId: "br-snapshot", dstBranchId: "br-restored", kind: "sandbox" }));
      expect(leases("br-restored")).toEqual(legacyRows.map(([agentId, kind, principal, epoch, expires]) =>
        [agentId, kind, principal, Number(epoch) + 1, expires]));
      // 扩展后的 CHECK 接受 script，仍拒绝其他取值。
      port.transact((tx) => tx.branch("br-online").table("controller_leases").put({
        agent_id: "human-pacifist", controller_kind: "script", controller_principal_id: "run-online",
        controller_epoch: 1, lease_expires_at: null,
      }));
      expect(leases("br-online")).toContainEqual(["human-pacifist", "script", "run-online", 1, null]);
      expect(() => port.transact((tx) => tx.branch("br-online").table("controller_leases").put({
        agent_id: "human-earth-alliance", controller_kind: "robot", controller_principal_id: null,
        controller_epoch: 1, lease_expires_at: null,
      }))).toThrow();
    } finally {
      if (legacy !== null) {
        closeDatabase(legacy);
      }
      await upgraded?.dispose();
      rmSync(dataDir, { recursive: true, force: true });
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
