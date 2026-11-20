/**
 * 存储模块测试共享的临时数据目录、确定性宿主与模块启停助手。
 * 依赖 node:fs、node:os、node:path 创建隔离目录，公共契约的宿主服务与端口类型。
 * 禁止访问真实用户目录、让测试共享同一数据目录，或在测试之间复用已关闭的连接。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  DomainError,
  canonicalJson,
  type ErrorCode,
  type HostServices,
  type Json,
  type ModuleCreateInput,
  type StoragePort,
} from "@ai-npc/contracts";
import { storageModuleDefinition } from "../src/definition";

/** 捕获的一条宿主日志；测试用它断言迁移与打开事件。 */
export interface CapturedLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data?: Json;
}

/** 确定性宿主服务：时间、ID、随机源与哈希都可复现，日志被收集而不是输出到控制台。 */
export interface FakeHost extends HostServices {
  readonly logs: CapturedLog[];
}

/** 构造确定性宿主；nowIso 每次调用递增 1 秒，便于备份文件名不冲突。 */
export function createFakeHost(startIso = "2026-01-01T00:00:00.000Z"): FakeHost {
  const logs: CapturedLog[] = [];
  let nowCounter = 0;
  let idCounter = 0;
  const start = Date.parse(startIso);
  const host: FakeHost = {
    logs,
    ids: (prefix: string) => {
      idCounter += 1;
      return `${prefix}-${String(idCounter).padStart(4, "0")}`;
    },
    nowIso: () => {
      const value = new Date(start + nowCounter * 1000).toISOString();
      nowCounter += 1;
      return value;
    },
    monotonicMs: () => nowCounter * 10,
    sleep: async () => {
      // 存储适配器不使用等待；空实现保持宿主契约完整。
    },
    rng: () => () => 0.5,
    hash: async (value: Json) => createHash("sha256").update(canonicalJson(value)).digest("hex"),
    logger: {
      info: (message, data) => {
        logs.push(data === undefined ? { level: "info", message } : { level: "info", message, data });
      },
      warn: (message, data) => {
        logs.push(data === undefined ? { level: "warn", message } : { level: "warn", message, data });
      },
      error: (message, data) => {
        logs.push(data === undefined ? { level: "error", message } : { level: "error", message, data });
      },
    },
    tracer: {
      span: <T>(_name: string, _attrs: Json, fn: () => T): T => fn(),
    },
  };
  return host;
}

/** 已启动的存储实例句柄：端口、宿主与关闭入口。 */
export interface StorageHandle {
  readonly dataDir: string;
  readonly port: StoragePort;
  readonly host: FakeHost;
  dispose(): Promise<void>;
}

/** 在指定数据目录启动一个存储模块实例；调用方负责关闭与清理。 */
export async function startStorage(dataDir: string, host: FakeHost = createFakeHost()): Promise<StorageHandle> {
  const signal = new AbortController().signal;
  const input: ModuleCreateInput = {
    moduleId: storageModuleDefinition.id,
    realm: "server",
    config: { dataDir },
    scope: {},
    ports: {},
    host,
    signal,
  };
  const instance = await storageModuleDefinition.create(input);
  await instance.start(signal);
  const port = instance.port;
  if (port === undefined) {
    throw new Error("存储模块实例没有暴露端口");
  }
  return {
    dataDir,
    port: port as StoragePort,
    host,
    dispose: async () => {
      await instance.dispose();
    },
  };
}

/** 创建唯一的临时数据目录；测试结束时由调用方删除。 */
export function createTempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "ai-npc-storage-test-"));
}

/** 删除临时数据目录及其中的数据库与备份。 */
export function removeTempDataDir(dataDir: string): void {
  rmSync(dataDir, { recursive: true, force: true });
}

/** 打开一个独立临时目录的存储实例，并在 dispose 时自动清理。 */
export async function openStorageHarness(): Promise<StorageHandle> {
  const dataDir = createTempDataDir();
  const handle = await startStorage(dataDir);
  return {
    ...handle,
    dispose: async () => {
      await handle.dispose();
      removeTempDataDir(dataDir);
    },
  };
}

/** 断言同步调用抛出指定错误码的领域错误。 */
export function expectDomainError(fn: () => unknown, code: ErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}
