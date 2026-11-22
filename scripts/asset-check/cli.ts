/**
 * 核心职责：输出资产校验结果并判定 CLI 退出码，提供直接执行判定。
 * 交互契约：失败项逐行打印明确原因，成功时报告覆盖数量；返回 0 或 1。
 * 约束与禁忌：禁止在此扩展校验规则；规则缺口由主检查器报告。
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAssets } from "./checker";
import type { AssetCliOptions } from "./report-types";

/** 输出校验结果并返回退出码；失败项逐行打印明确原因，成功时报告覆盖数量。 */
export function runAssetCheckCli(options: AssetCliOptions = {}): number {
  const report = checkAssets({ root: options.root });
  const writeStdout = options.writeStdout ?? ((text: string): void => {
    process.stdout.write(text);
  });
  const writeStderr = options.writeStderr ?? ((text: string): void => {
    process.stderr.write(text);
  });
  if (report.violations.length === 0) {
    writeStdout(`资产校验通过：${report.assetCount} 个 SVG，覆盖 ${report.nodeCount} 个节点、${report.factionCount} 个派系。\n`);
    return 0;
  }
  writeStderr(`资产校验失败：${report.violations.length} 项。\n`);
  for (const violation of report.violations) {
    writeStderr(`  [${violation.code}] ${violation.message}\n`);
  }
  return 1;
}

export function isDirectExecution(moduleUrl: string): boolean {
  const entryPath = process.argv[1] ?? "";
  if (entryPath.length === 0) {
    return false;
  }
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolve(entryPath)) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === modulePath;
  }
}
