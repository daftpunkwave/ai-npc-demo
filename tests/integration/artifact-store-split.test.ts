/**
 * 验证 artifact 仓按存储端口的内联上限分流正文：等于上限的正文内联，超过上限的正文写入独立文件并登记 file_path，
 * 对白 artifact 始终内联，登记失败时清理刚写入的文件，读取方在事务外按登记方式取回同一正文。
 * 依赖真实 SQLite 存储模块、module-sdk 的 artifact 仓与临时数据目录。
 * 禁止用 mock 存储替代真实事务与文件，或只断言写入成功而不核对登记行与读回内容。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, type Json, type ModuleInstance, type StoragePort, type StorageRow } from "@world-prism/contracts";
import { artifactBodyText, StoredAgentArtifactStore } from "@world-prism/module-sdk";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { createFakeHost } from "./authority-support";

/** 用于测试的内联上限：远小于缺省值，便于构造边界正文。 */
const inlineMaxBytes = 256;

/** 构造规范 JSON 正文恰好为 byteSize 字节的值；规范 JSON 为 `{"text":"…"}`，外壳占 11 字节。 */
function valueOfSize(byteSize: number): Json {
  const value = { text: "x".repeat(byteSize - 11) };
  expect(new TextEncoder().encode(canonicalJson(value)).byteLength).toBe(byteSize);
  return value;
}

describe("artifact 正文按内联上限分流", () => {
  let dataDir: string;
  let instance: ModuleInstance | undefined;
  let storage: StoragePort;
  let artifacts: StoredAgentArtifactStore;

  const rowOf = (artifactId: string): StorageRow | null =>
    storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
  const artifactDirectory = (): readonly string[] =>
    existsSync(join(dataDir, "artifacts")) ? readdirSync(join(dataDir, "artifacts")) : [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "world-prism-artifact-split-"));
    const host = createFakeHost();
    const signal = new AbortController().signal;
    instance = await storageModuleDefinition.create({
      host, signal, moduleId: storageModuleDefinition.id, config: { dataDir, inlineArtifactMaxBytes: inlineMaxBytes },
      realm: "server", ports: {}, scope: {},
    });
    await instance.start(signal);
    storage = instance.port as StoragePort;
    artifacts = new StoredAgentArtifactStore(storage, host);
  });

  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("正文等于上限时内联进 body，不写文件", async () => {
    const stored = await artifacts.put({ artifactId: "art-equal", runId: null, kind: "tool-raw", value: valueOfSize(inlineMaxBytes) });
    const row = rowOf("art-equal");
    expect(row).toMatchObject({ storage: "inline", file_path: null, byte_size: inlineMaxBytes });
    expect(row?.["body"]).toBeInstanceOf(Uint8Array);
    expect(stored.byteSize).toBe(inlineMaxBytes);
    expect(artifactDirectory()).toEqual([]);
  });

  it.each([
    ["略大于上限", inlineMaxBytes + 1],
    ["远大于上限", inlineMaxBytes * 64],
  ])("正文%s时写入独立文件并登记 file_path", async (_label, byteSize) => {
    const value = valueOfSize(byteSize);
    const stored = await artifacts.put({ artifactId: "art-large", runId: null, kind: "model-request", value });
    const row = rowOf("art-large");
    expect(row).toMatchObject({ storage: "file", body: null, file_path: "artifacts/art-large", byte_size: byteSize });
    expect(artifactDirectory()).toEqual(["art-large"]);
    expect(artifacts.get("art-large")).toEqual({ ...stored, value });
    expect(row === null ? null : artifactBodyText(storage, row)).toBe(canonicalJson(value));
  });

  it("对白 artifact 超过上限也内联：turn 取消在命令事务内读取其正文", async () => {
    await artifacts.put({ artifactId: "art-speech", runId: null, kind: "speech", value: valueOfSize(inlineMaxBytes * 2) });
    expect(rowOf("art-speech")).toMatchObject({ storage: "inline", file_path: null, byte_size: inlineMaxBytes * 2 });
    expect(artifactDirectory()).toEqual([]);
  });

  it("content_hash 对规范正文文本求一次摘要，结果与 host.hash 对同一值一致", async () => {
    const host = createFakeHost();
    const calls = { hash: 0, hashText: [] as string[] };
    const store = new StoredAgentArtifactStore(storage, {
      ...host,
      hash: async (value) => {
        calls.hash += 1;
        return host.hash(value);
      },
      hashText: async (text) => {
        calls.hashText.push(text);
        return host.hashText(text);
      },
    });
    const value: Json = { zeta: 1, alpha: [true, "正文"] };
    const stored = await store.put({ artifactId: "art-hash", runId: null, kind: "tool-view", value });
    expect(calls.hash).toBe(0);
    expect(calls.hashText).toEqual([canonicalJson(value)]);
    expect(stored.contentHash).toBe(await host.hash(value));
    expect(rowOf("art-hash")?.["content_hash"]).toBe(stored.contentHash);
  });

  it("登记事务失败时删除刚写入的正文文件，既有 artifact 保持不变", async () => {
    await artifacts.put({ artifactId: "art-taken", runId: null, kind: "tool-raw", value: { text: "small" } });
    await expect(artifacts.put({
      artifactId: "art-taken", runId: null, kind: "tool-raw", value: valueOfSize(inlineMaxBytes + 1),
    })).rejects.toThrow("artifact art-taken already exists");
    expect(artifactDirectory()).toEqual([]);
    expect(rowOf("art-taken")).toMatchObject({ storage: "inline", file_path: null });
    expect(artifacts.get("art-taken")?.value).toEqual({ text: "small" });
  });
});
