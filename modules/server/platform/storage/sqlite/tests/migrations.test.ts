/**
 * 验证迁移与表目录：表数量、版本记录、重复打开幂等、PRAGMA 生效、job 推进索引、分支级表清单与运营幂等表部署级身份。
 * 依赖存储模块测试助手与迁移推导的分支级表常量。
 * 禁止连接真实数据库文件、跳过失败迁移断言或把运行级表当作分支级表。
 */
import { describe, expect, it } from "vitest";
import type { StoragePort } from "@ai-npc/contracts";
import { BRANCH_TABLES, OPERATION_IDEMPOTENCY_TABLE } from "../src/sqlite/schema";
import { createTempDataDir, openStorageHarness, removeTempDataDir, startStorage } from "./support";

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

describe("初始迁移", () => {
  it("首次打开执行全部迁移并记录版本", async () => {
    const harness = await openStorageHarness();
    try {
      const versions = harness.port.transact((tx) =>
        tx.all("SELECT version, applied_at FROM schema_migrations ORDER BY version"),
      );
      expect(versions.map((row) => row["version"])).toEqual([1, 2, 3]);
      for (const version of versions) {
        expect(typeof version["applied_at"]).toBe("string");
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
        expect(versions.map((row) => row["version"])).toEqual([1, 2, 3]);
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
