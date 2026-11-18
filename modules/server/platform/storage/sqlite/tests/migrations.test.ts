/**
 * 验证初始迁移与表目录：表数量、版本记录、重复打开幂等、PRAGMA 生效与分支级表清单一致。
 * 依赖存储模块测试助手与迁移推导的分支级表常量。
 * 禁止连接真实数据库文件、跳过失败迁移断言或把运行级表当作分支级表。
 */
import { describe, expect, it } from "vitest";
import type { StoragePort } from "@ai-npc/contracts";
import { BRANCH_TABLES } from "../src/sqlite/schema";
import { createTempDataDir, openStorageHarness, removeTempDataDir, startStorage } from "./support";

/** 迁移中的表总数：部署级 9 + 分支级 18 + 运行级 12。 */
const EXPECTED_TABLE_COUNT = 39;

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
  it("首次打开建表并记录版本 1", async () => {
    const harness = await openStorageHarness();
    try {
      const versions = harness.port.transact((tx) =>
        tx.all("SELECT version, applied_at FROM schema_migrations ORDER BY version"),
      );
      expect(versions).toHaveLength(1);
      expect(versions[0]?.["version"]).toBe(1);
      expect(typeof versions[0]?.["applied_at"]).toBe("string");
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
        expect(versions.map((row) => row["version"])).toEqual([1]);
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
