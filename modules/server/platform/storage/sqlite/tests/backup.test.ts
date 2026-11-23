/**
 * 验证整库备份：暂存文件先通过完整性检查再原子发布，成功副本可重新打开、数据一致、不覆盖同名文件，
 * 失败时清理暂存文件且不在备份目录留下可被误认为有效的 .db。
 * 依赖 node:sqlite 重新打开备份、node:fs 检查文件与权限、存储模块测试助手。
 * 禁止用复制数据库文件代替备份，或忽略事务内备份、非法标签与失败清理的拒绝断言。
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DomainError } from "@ai-npc/contracts";
import { backupDatabase, maxRetainedBackups } from "../src/sqlite/backup";
import { createFakeHost, createTempDataDir, expectDomainError, openStorageHarness, removeTempDataDir, startStorage } from "./support";

/** 从备份实现发出的 VACUUM INTO 语句中取出暂存文件路径，供失败注入使用。 */
function stagedPathFromVacuumSql(sql: string): string {
  const match = /^VACUUM INTO '(.*)'$/.exec(sql);
  if (match?.[1] === undefined) {
    throw new Error(`测试未识别 VACUUM INTO 语句：${sql}`);
  }
  return match[1].replaceAll("''", "'");
}

/** 只实现 VACUUM INTO 执行的数据库替身；用于注入真实 SQLite 难以稳定复现的失败。 */
function databaseRunning(exec: (sql: string) => void): DatabaseSync {
  return { exec } as unknown as DatabaseSync;
}

describe("整库备份", () => {
  it("生成可重新打开且通过完整性检查的副本", async () => {
    const harness = await openStorageHarness();
    try {
      harness.port.transact((tx) => {
        tx.rows("worlds").put({
          world_id: "wld-1",
          pack_id: "earth-2964-v1",
          content_version: "v1",
          created_at: "2026-01-01T00:00:00.000Z",
        });
      });
      const result = harness.port.backup({ label: "nightly" });
      expect(existsSync(result.path)).toBe(true);
      expect(result.path.endsWith(".db")).toBe(true);
      expect(result.byteSize).toBeGreaterThan(0);
      expect(result.path).toContain("backups");
      // 发布后的备份目录只有最终文件，没有遗留的暂存文件。
      const backupDir = join(harness.dataDir, "backups");
      expect(readdirSync(backupDir)).toEqual([basename(result.path)]);
      const audit = harness.host.logs.find((log) => log.message === "SQLite 备份已生成");
      expect(audit?.data).toMatchObject({
        path: result.path,
        byteSize: result.byteSize,
        integrityCheck: "ok",
      });
      const backup = new DatabaseSync(result.path, { readOnly: true });
      try {
        expect(backup.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
        const worlds = backup.prepare("SELECT world_id FROM worlds").all();
        expect(worlds.map((row) => row["world_id"])).toEqual(["wld-1"]);
        expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.["version"]).toBe(13);
      } finally {
        backup.close();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("同一时间戳的同名备份追加序号而不是覆盖", async () => {
    const dataDir = createTempDataDir();
    const host = createFakeHost();
    host.nowIso = () => "2026-01-01T00:00:00.000Z";
    const handle = await startStorage(dataDir, host);
    try {
      const first = handle.port.backup({ label: "fixed" });
      const second = handle.port.backup({ label: "fixed" });
      expect(second.path).not.toBe(first.path);
      expect(existsSync(first.path)).toBe(true);
      expect(existsSync(second.path)).toBe(true);
      expect(readdirSync(join(dataDir, "backups")).some((entry) => entry.endsWith(".partial"))).toBe(false);
    } finally {
      await handle.dispose();
      removeTempDataDir(dataDir);
    }
  });

  it("拒绝事务内备份与非法标签", async () => {
    const harness = await openStorageHarness();
    try {
      expectDomainError(
        () =>
          harness.port.transact(() => {
            harness.port.backup();
          }),
        "invalid-state",
      );
      expectDomainError(() => harness.port.backup({ label: "../evil" }), "validation");
    } finally {
      await harness.dispose();
    }
  });

  it("VACUUM INTO 失败时删除暂存文件，不留下可被误认的有效备份", () => {
    const dataDir = createTempDataDir();
    try {
      const database = databaseRunning((sql) => {
        // 模拟 VACUUM INTO 已写出部分内容后失败。
        writeFileSync(stagedPathFromVacuumSql(sql), "incomplete sqlite backup", "utf8");
        throw new Error("注入的 VACUUM INTO 失败");
      });
      let caught: unknown;
      try {
        backupDatabase(database, dataDir, createFakeHost());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).code).toBe("invalid-state");
      expect((caught as Error).message).toMatch(/生成 SQLite 备份失败：注入的 VACUUM INTO 失败/);
      expect((caught as DomainError).details).toMatchObject({
        stagingPath: expect.stringContaining(".partial"),
      });
      expect(readdirSync(join(dataDir, "backups"))).toEqual([]);
    } finally {
      removeTempDataDir(dataDir);
    }
  });

  it("完整性检查失败时删除暂存文件，不发布最终 .db", () => {
    const dataDir = createTempDataDir();
    try {
      const database = databaseRunning((sql) => {
        // VACUUM INTO 返回后暂存文件存在但不是可用的 SQLite 数据库。
        writeFileSync(stagedPathFromVacuumSql(sql), "not a sqlite database", "utf8");
      });
      let caught: unknown;
      try {
        backupDatabase(database, dataDir, createFakeHost());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as Error).message).toMatch(/生成 SQLite 备份失败/);
      expect(readdirSync(join(dataDir, "backups"))).toEqual([]);
    } finally {
      removeTempDataDir(dataDir);
    }
  });

  it.skipIf(process.platform === "win32")("发布后的备份权限为仅当前用户可读写", async () => {
    // Windows 只支持受限的权限位语义，本用例只在类 Unix 平台验证。
    const harness = await openStorageHarness();
    try {
      const result = harness.port.backup({ label: "secure" });
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    } finally {
      await harness.dispose();
    }
  });
  it('成功发布后按数量保留最近备份', async () => {
    const harness = await openStorageHarness();
    try {
      const paths: string[] = [];
      for (let index = 0; index < maxRetainedBackups + 2; index += 1) {
        harness.host.nowIso = () => `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
        paths.push(harness.port.backup({ label: "rotate" }).path);
      }
      const backups = readdirSync(join(harness.dataDir, "backups")).sort();
      expect(backups).toHaveLength(maxRetainedBackups);
      expect(backups).not.toContain(basename(paths[0] ?? ""));
      expect(backups).toContain(basename(paths.at(-1) ?? ""));
    } finally {
      await harness.dispose();
    }
  });});
