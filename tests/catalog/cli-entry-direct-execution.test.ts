/**
 * 校验三个 CLI 公开入口的直接执行与导入行为：直接执行时运行对应检查并输出结果，
 * 作为模块导入时保持静默；check-assets 公开入口不再暴露 isDirectExecution。
 * 以 node 运行仓库 tsx CLI 启动子进程，断言真实 stdout、stderr 与退出码。
 * 禁止在本进程内直接调用入口的 CLI 函数替代子进程验证，或在断言中放宽退出码。
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsxCliPath = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const importFixturePath = join(repositoryRoot, "tests/catalog/fixtures/cli-entry-import-fixture.ts");

interface CliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** 以仓库内 tsx 运行目标脚本，收集完整 stdout、stderr 与退出码。 */
function runTsx(scriptPath: string): Promise<CliRunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [tsxCliPath, scriptPath], { cwd: repositoryRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ stdout, stderr, code }));
  });
}

describe("CLI 入口直接执行与导入行为", () => {
  it("直接执行 check-boundaries 时运行扫描并报告结果", async () => {
    const run = await runTsx("scripts/check-boundaries.ts");
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("边界检查：扫描");
    expect(run.stdout).toContain("未发现边界违规");
  });

  it("直接执行 check-catalog 时运行装配预检并报告结果", async () => {
    const run = await runTsx("scripts/check-catalog.ts");
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("catalog ok:");
  });

  it("直接执行 check-assets 时运行资产校验并报告结果", async () => {
    const run = await runTsx("scripts/check-assets.ts");
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("资产校验通过");
  });

  it("作为模块导入三个入口时不产生任何输出且正常退出", async () => {
    const run = await runTsx(importFixturePath);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  it("check-assets 公开入口不再暴露 isDirectExecution，共享工具保持可用", async () => {
    const checkAssetsEntry = await import("@ai-npc/scripts/check-assets");
    expect("isDirectExecution" in checkAssetsEntry).toBe(false);
    const sharedDetector = await import("@ai-npc/scripts/direct-execution");
    expect(typeof sharedDetector.isDirectExecution).toBe("function");
  });
});
