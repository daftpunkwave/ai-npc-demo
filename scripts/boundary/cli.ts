/**
 * 边界检查的格式化与 CLI 入口：输出 file:line 加规则编号，违规时返回非零退出码。
 * 只在被直接执行时扫描仓库；作为模块导入时不启动扫描、不打印任何内容。
 * 禁止在此忽略违规、修改退出码或把检查结果写入仓库。
 */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundaries } from "./checker";
import { scanRepository } from "./repository";
import type { BoundaryViolation } from "./types";

export function formatViolation(item: BoundaryViolation): string {
  return `${item.file}:${item.line}: [规则 ${item.rule} / ${item.code}] ${item.message}`;
}

function isDirectExecution(moduleUrl: string): boolean {
  const entryPath = process.argv[1];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- process.argv[1] 在仓库 noUncheckedIndexedAccess 下可能为 undefined；Codacy 未开启该选项。
  if (entryPath === undefined) {
    return false;
  }
  const modulePath = fileURLToPath(moduleUrl);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 只比较仓库内固定入口文件的 realpath，不是外部路径。
    return realpathSync(resolve(entryPath)) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === modulePath;
  }
}

function runCli(): void {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const input = scanRepository(repositoryRoot);
  const violations = checkBoundaries(input);
  process.stdout.write(
    `边界检查：扫描 ${input.files.length} 个源码文件、${input.packages.length} 个 workspace 包。\n`,
  );
  if (violations.length === 0) {
    process.stdout.write("未发现边界违规。\n");
    return;
  }
  process.stderr.write(`发现 ${violations.length} 个边界违规：\n`);
  for (const item of violations) {
    process.stderr.write(`  ${formatViolation(item)}\n`);
  }
  process.exitCode = 1;
}

/** 仅当该模块被当作脚本直接执行时运行 CLI；被测试导入时保持静默。 */
export function runCliIfDirectExecution(moduleUrl: string): void {
  if (isDirectExecution(moduleUrl)) {
    runCli();
  }
}
