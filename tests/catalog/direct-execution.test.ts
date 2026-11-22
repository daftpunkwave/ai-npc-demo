/**
 * 校验共享的 CLI 直接执行判定：argv[1] 判空、realpath 比较与解析失败回退字符串比较。
 * 只依赖临时目录中的真实文件路径与 process.argv 注入；不启动子进程、不触发任何检查脚本。
 * 禁止在测试中遗留 argv 修改，或依赖仓库内固定路径的 realpath 结果。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isDirectExecution } from "@ai-npc/scripts/direct-execution";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createEntryFile(): string {
  const root = mkdtempSync(join(tmpdir(), "direct-execution-"));
  temporaryRoots.push(root);
  const entryPath = join(root, "entry.ts");
  writeFileSync(entryPath, "export {};\n");
  return entryPath;
}

/** 以注入的 argv[1] 执行判定，结束后恢复原值，避免污染同进程其他用例。 */
function withEntryPath<T>(entryPath: string | undefined, action: () => T): T {
  const original = process.argv[1];
  process.argv[1] = entryPath as string;
  try {
    return action();
  } finally {
    process.argv[1] = original as string;
  }
}

describe("CLI 直接执行判定", () => {
  it("argv[1] 缺失或为空串时判为非直接执行", () => {
    const moduleUrl = pathToFileURL(createEntryFile()).href;
    expect(withEntryPath(undefined, () => isDirectExecution(moduleUrl))).toBe(false);
    expect(withEntryPath("", () => isDirectExecution(moduleUrl))).toBe(false);
  });

  it("入口路径与模块路径 realpath 相同时判为直接执行，不同时判为否", () => {
    const entryPath = createEntryFile();
    const otherPath = createEntryFile();
    expect(withEntryPath(entryPath, () => isDirectExecution(pathToFileURL(entryPath).href))).toBe(true);
    expect(withEntryPath(entryPath, () => isDirectExecution(pathToFileURL(otherPath).href))).toBe(false);
  });

  it("realpath 解析失败时回退为路径字符串比较", () => {
    const missingPath = join(tmpdir(), "direct-execution-missing-entry.ts");
    expect(withEntryPath(missingPath, () => isDirectExecution(pathToFileURL(missingPath).href))).toBe(true);
    expect(
      withEntryPath(missingPath, () => isDirectExecution(pathToFileURL(`${missingPath}.other`).href)),
    ).toBe(false);
  });
});
