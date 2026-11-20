/**
 * 验证整库备份：VACUUM INTO 生成的副本可重新打开、通过完整性检查、数据一致且不覆盖同名文件。
 * 依赖 node:sqlite 重新打开备份、node:fs 检查文件，以及存储模块测试助手。
 * 禁止用复制数据库文件代替备份，或忽略事务内备份与非法标签的拒绝断言。
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createFakeHost, createTempDataDir, expectDomainError, openStorageHarness, removeTempDataDir, startStorage } from "./support";

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
      expect(result.byteSize).toBeGreaterThan(0);
      expect(result.path).toContain("backups");
      const backup = new DatabaseSync(result.path, { readOnly: true });
      try {
        expect(backup.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
        const worlds = backup.prepare("SELECT world_id FROM worlds").all();
        expect(worlds.map((row) => row["world_id"])).toEqual(["wld-1"]);
        expect(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.["version"]).toBe(4);
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
});
