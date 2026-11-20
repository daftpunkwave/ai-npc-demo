/**
 * 验证存储打开期间的并发调用、取消与关闭行为。
 * 依赖存储适配器、模块定义与可延迟的确定性哈希端口。
 * 禁止泄漏连接、允许已取消的启动成功，或让并发打开创建多个写连接。
 */
import { describe, expect, it } from "vitest";
import type { ModuleCreateInput, StoragePort } from "@ai-npc/contracts";
import { storageModuleDefinition } from "../src/definition";
import { SqliteStorage } from "../src/sqlite/storage";
import {
  createFakeHost,
  createTempDataDir,
  removeTempDataDir,
  type FakeHost,
} from "./support";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

function delayedHashHost(): { readonly host: FakeHost; readonly entered: Promise<void>; release(): void } {
  const base = createFakeHost();
  const entered = deferred();
  const release = deferred();
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    host: {
      ...base,
      hash: async (value) => {
        entered.resolve();
        await release.promise;
        return base.hash(value);
      },
    },
  };
}

describe("存储生命周期", () => {
  it("并发打开共享同一个进行中的连接", async () => {
    const dataDir = createTempDataDir();
    const storage = new SqliteStorage(
      { dataDir, inlineArtifactMaxBytes: 65536 },
      createFakeHost(),
    );
    try {
      await Promise.all([storage.open(), storage.open()]);
      expect(storage.isOpen).toBe(true);
      expect(storage.transact((tx) => tx.get("SELECT 1 AS value")?.["value"])).toBe(1);
    } finally {
      storage.close();
      removeTempDataDir(dataDir);
    }
  });

  it("打开期间关闭会取消安装连接", async () => {
    const dataDir = createTempDataDir();
    const delayed = delayedHashHost();
    const storage = new SqliteStorage(
      { dataDir, inlineArtifactMaxBytes: 65536 },
      delayed.host,
    );
    try {
      const opening = storage.open();
      await delayed.entered;
      storage.close();
      delayed.release();
      await expect(opening).rejects.toMatchObject({ code: "cancelled" });
      expect(storage.isOpen).toBe(false);
    } finally {
      storage.close();
      removeTempDataDir(dataDir);
    }
  });

  it("启动信号在迁移期间中止时关闭连接并拒绝启动", async () => {
    const dataDir = createTempDataDir();
    const delayed = delayedHashHost();
    const signal = new AbortController();
    const input: ModuleCreateInput = {
      moduleId: storageModuleDefinition.id,
      realm: "server",
      config: { dataDir, inlineArtifactMaxBytes: 65536 },
      scope: {},
      ports: {},
      host: delayed.host,
      signal: signal.signal,
    };
    const instance = await storageModuleDefinition.create(input);
    try {
      const starting = instance.start(signal.signal);
      await delayed.entered;
      signal.abort();
      delayed.release();
      await expect(starting).rejects.toMatchObject({ code: "cancelled" });
      expect((instance.port as (StoragePort & { readonly isOpen: boolean })).isOpen).toBe(false);
    } finally {
      await instance.dispose();
      removeTempDataDir(dataDir);
    }
  });
});
