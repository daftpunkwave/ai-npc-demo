/**
 * 验证 artifact 大正文文件存放：内联上限取自配置，正文以独占方式写入 dataDir/artifacts 并按登记路径读回，
 * 已存在的正文不被覆盖、暂存文件不残留，登记路径不能指向 artifact 目录之外。
 * 依赖 node:fs 检查目录内容与存储模块测试助手。
 * 禁止用 mock 文件系统替代真实临时目录，或省略越界路径与重复写入的拒绝断言。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHost, createTempDataDir, expectDomainError, removeTempDataDir, startStorage, type StorageHandle } from "./support";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("artifact 正文文件", () => {
  let handle: StorageHandle | undefined;

  afterEach(async () => {
    if (handle !== undefined) {
      await handle.dispose();
      removeTempDataDir(handle.dataDir);
      handle = undefined;
    }
  });

  const open = async (inlineArtifactMaxBytes?: number): Promise<StorageHandle> => {
    handle = await startStorage(
      createTempDataDir(),
      createFakeHost(),
      inlineArtifactMaxBytes === undefined ? {} : { inlineArtifactMaxBytes },
    );
    return handle;
  };

  it("内联上限缺省为 65536 字节", async () => {
    expect((await open()).port.artifactFiles.inlineMaxBytes).toBe(65536);
  });

  it("内联上限取自装配配置的 inlineArtifactMaxBytes", async () => {
    expect((await open(128)).port.artifactFiles.inlineMaxBytes).toBe(128);
  });

  it("写入 dataDir/artifacts 并按登记路径原样读回，不残留暂存文件", async () => {
    const { port, dataDir } = await open();
    const filePath = port.artifactFiles.write("art-0001", bytes("{\"value\":\"正文\"}"));
    expect(filePath).toBe("artifacts/art-0001");
    expect(readdirSync(join(dataDir, "artifacts"))).toEqual(["art-0001"]);
    expect(new TextDecoder().decode(port.artifactFiles.read(filePath))).toBe("{\"value\":\"正文\"}");
  });

  it("同名正文已存在时拒绝覆盖，原内容保持不变", async () => {
    const { port, dataDir } = await open();
    const filePath = port.artifactFiles.write("art-0002", bytes("first"));
    expectDomainError(() => port.artifactFiles.write("art-0002", bytes("second")), "invalid-state");
    expect(new TextDecoder().decode(port.artifactFiles.read(filePath))).toBe("first");
    expect(readdirSync(join(dataDir, "artifacts"))).toEqual(["art-0002"]);
  });

  it("删除登记失败的正文文件，文件不存在时也不报错", async () => {
    const { port, dataDir } = await open();
    const filePath = port.artifactFiles.write("art-0003", bytes("orphan"));
    port.artifactFiles.remove(filePath);
    expect(existsSync(join(dataDir, "artifacts", "art-0003"))).toBe(false);
    expect(() => port.artifactFiles.remove(filePath)).not.toThrow();
  });

  it.each([
    "../world-prism.db",
    "artifacts/../world-prism.db",
    "artifacts/sub/art-0004",
    "artifacts/",
    "/etc/passwd",
    "artifacts\\..\\world-prism.db",
  ])("拒绝 artifact 目录之外的登记路径 %s", async (filePath) => {
    const { port } = await open();
    expect(() => port.artifactFiles.read(filePath)).toThrow();
    expect(() => port.artifactFiles.remove(filePath)).toThrow();
  });

  it.each(["../escape", "a/b", ".hidden", ""])("拒绝不能用作文件名的 artifact ID %j", async (artifactId) => {
    const { port, dataDir } = await open();
    expectDomainError(() => port.artifactFiles.write(artifactId, bytes("x")), "validation");
    expect(existsSync(join(dataDir, "artifacts")) ? readdirSync(join(dataDir, "artifacts")) : []).toEqual([]);
  });
});
