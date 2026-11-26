/**
 * 核心职责：验证连接级预编译语句缓存被多次事务与表级读写共享、事务结束不清空、上界到达后整体重置，
 * 以及缓存随连接关闭丢弃、重新打开后从空开始。
 * 交互契约：依赖存储模块测试助手、SqliteStorage 与语句缓存；用 spy 统计真实连接的 prepare 调用次数作为命中证据。
 * 约束与禁忌：禁止让测试共享数据目录、依赖驱动内部的语句状态，或断言未声明的缓存淘汰顺序。
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { SqliteStorage } from "../src/sqlite/storage";
import { STATEMENT_CACHE_LIMIT, type StatementCache } from "../src/sqlite/statement-cache";
import { createFakeHost, createTempDataDir, openStorageHarness, removeTempDataDir } from "./support";

const BRANCH_ID = "brn-cache";

/** 存储适配器内部持有的缓存；测试经它断言命中与清空，不触碰连接本身。 */
interface CacheInternals {
  readonly statements: StatementCache | null;
}

function requireCache(storage: SqliteStorage): StatementCache {
  const cache = (storage as unknown as CacheInternals).statements;
  if (cache === null) {
    throw new Error("存储适配器尚未打开语句缓存");
  }
  return cache;
}

describe("连接级语句缓存", () => {
  it("同一 SQL 跨多次 transact 只预编译一次", async () => {
    const harness = await openStorageHarness();
    try {
      const cache = requireCache(harness.port as unknown as SqliteStorage);
      harness.port.transact((tx) => tx.get("SELECT 1 AS value"));
      const warmed = cache.size;
      expect(cache.size).toBe(1);

      // 后续事务复用同一语句：缓存条目数不变，且数据库不再收到新的 prepare 调用。
      const database = (harness.port as unknown as { readonly database: DatabaseSync }).database;
      const prepareSpy = vi.spyOn(database, "prepare");
      try {
        for (let round = 0; round < 5; round += 1) {
          const value = harness.port.transact((tx) => tx.get("SELECT 1 AS value")?.["value"]);
          expect(value).toBe(1);
        }
        expect(prepareSpy).not.toHaveBeenCalled();
        expect(cache.size).toBe(warmed);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("表级读写与原始查询共用同一缓存，事务结束不清空", async () => {
    const harness = await openStorageHarness();
    try {
      const cache = requireCache(harness.port as unknown as SqliteStorage);
      // 第一次事务：写入并预热后续要读取的四条语句（put/get/count/max 与原始查询）。
      const seed = harness.port.transact((tx) => {
        const table = tx.branch(BRANCH_ID).table("aggregate_state");
        table.put({ aggregate_type: "stockpile", aggregate_id: "stk-cache", version: 1, state_json: { amount: 1 } });
        table.get({ aggregate_type: "stockpile", aggregate_id: "stk-cache" });
        table.max("version");
        tx.get("SELECT 1 AS value");
        return table.count();
      });
      expect(seed).toBe(1);
      const afterSeed = cache.size;
      expect(afterSeed).toBeGreaterThan(0);

      // 第二次事务重建了 TableAccess 句柄，但读取仍命中缓存里的同一批语句。
      const database = (harness.port as unknown as { readonly database: DatabaseSync }).database;
      const prepareSpy = vi.spyOn(database, "prepare");
      try {
        const read = harness.port.transact((tx) => {
          const table = tx.branch(BRANCH_ID).table("aggregate_state");
          return {
            row: table.get({ aggregate_type: "stockpile", aggregate_id: "stk-cache" })?.["version"],
            count: table.count(),
            max: table.max("version"),
            raw: tx.get("SELECT 1 AS value")?.["value"],
          };
        });
        expect(read).toEqual({ row: 1, count: 1, max: 1, raw: 1 });
        expect(prepareSpy).not.toHaveBeenCalled();
        expect(cache.size).toBe(afterSeed);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      await harness.dispose();
    }
  });

  it("达到上界时整体清空后重新装入，不做逐条淘汰", async () => {
    const dataDir = createTempDataDir();
    const storage = new SqliteStorage({ dataDir, inlineArtifactMaxBytes: 65536 }, createFakeHost());
    try {
      await storage.open();
      const cache = requireCache(storage);
      // 直接调用缓存接口：每个不同 SQL 文本都是新条目，不依赖业务 SQL 的具体形态。
      for (let index = 0; index < STATEMENT_CACHE_LIMIT; index += 1) {
        cache.prepare(`SELECT ${index} AS value`);
      }
      expect(cache.size).toBe(STATEMENT_CACHE_LIMIT);

      // 第 257 条触发整体清空，装入后只剩这一条，说明不是 LRU 而是有界重置。
      const overflow = cache.prepare("SELECT 999 AS value");
      expect(cache.size).toBe(1);
      expect(Number(overflow.get()?.["value"])).toBe(999);
    } finally {
      storage.close();
      removeTempDataDir(dataDir);
    }
  });

  it("关闭连接时丢弃缓存，重新打开后从空开始", async () => {
    const dataDir = createTempDataDir();
    const storage = new SqliteStorage({ dataDir, inlineArtifactMaxBytes: 65536 }, createFakeHost());
    try {
      await storage.open();
      const firstCache = requireCache(storage);
      storage.transact((tx) => tx.get("SELECT 1 AS value"));
      expect(firstCache.size).toBe(1);

      storage.close();
      expect((storage as unknown as CacheInternals).statements).toBeNull();

      await storage.open();
      const reopened = requireCache(storage);
      // 用布尔断言比较身份：vitest 的结构化比较会枚举旧缓存持有的已关闭连接并抛错。
      expect(reopened === firstCache).toBe(false);
      expect(reopened.size).toBe(0);
      expect(storage.transact((tx) => tx.get("SELECT 1 AS value")?.["value"])).toBe(1);
      expect(reopened.size).toBe(1);
    } finally {
      storage.close();
      removeTempDataDir(dataDir);
    }
  });

  it("回滚并结束的事务不影响缓存语句的后续使用", async () => {
    const harness = await openStorageHarness();
    try {
      expect(() =>
        harness.port.transact((tx) => {
          expect(tx.get("SELECT 2 AS value")?.["value"]).toBe(2);
          throw new Error("预期回滚");
        }),
      ).toThrow("预期回滚");
      // 上一次事务回滚并 close() 后，缓存中的同一语句在后续事务里仍然可用。
      expect(harness.port.transact((tx) => tx.get("SELECT 2 AS value")?.["value"])).toBe(2);
      expect(harness.port.transact((tx) => tx.all("SELECT 2 AS value").length)).toBe(1);
    } finally {
      await harness.dispose();
    }
  });
});
