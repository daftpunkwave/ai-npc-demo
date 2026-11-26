/**
 * 核心职责：检查非测试手写源码的行数上限，把「按职责拆文件」的约定变成可执行门禁。
 * 交互契约：接收仓库扫描出的源码文件集合，输出超限文件的违规项；同一规则编号沿用边界检查，
 * 由 `pnpm check:boundaries` 汇总，测试可把夹具字符串直接交给纯函数。
 * 约束与禁忌：不判断职责是否真的混杂，不自动拆分文件，也不为超限文件开静默豁免；
 * 例外只能写在文件级的显式豁免表里，并附带理由。
 */
import { RULE_SOURCE_HEADER } from "./constants";
import type { BoundarySourceFile, BoundaryViolation } from "./types";

/** 单个源文件的行数上限；超过时按明确职责拆分文件，而不是继续加长。 */
export const SOURCE_FILE_LINE_LIMIT = 500;

/**
 * 显式豁免的单个文件：`reason` 必须说明为什么现在不拆，避免豁免变成静默放行。
 *
 * 客户端玩家端正在被 Godot/C# 原生端替换（见原生迁移计划），其实现会在替换中重写或退役，
 * 现在拆分只会产生一次性的中间形态。服务端文件不在此列。
 */
const EXEMPT_FILES: ReadonlyMap<string, string> = new Map([
  [
    "modules/client/world-view/standard/src/plugin.ts",
    "浏览器玩家端随原生端替换重写，不在当前服务端整改范围内拆分。",
  ],
]);

/**
 * 不参与行数门禁的路径：
 * - 测试文件与夹具：断言与样例密度高不等于职责混杂；
 * - 已发布的 SQL 迁移：内容参与校验和，改动既有迁移会破坏历史存档的可复现性；
 * - 样式表：本门禁针对手写 TypeScript 源文件的职责混杂，样式在独立规范中约束；
 * - 豁免表内列出的单个文件：附带理由，见 `EXEMPT_FILES`。
 */
export function isLengthExemptPath(filePath: string): boolean {
  if (isTestSourcePath(filePath)) {
    return true;
  }
  if (filePath.startsWith("modules/server/platform/storage/sqlite/migrations/")) {
    return true;
  }
  return filePath.endsWith(".css") || EXEMPT_FILES.has(filePath);
}

/** 已声明的文件级豁免与理由；供 CLI 输出与测试核对，避免豁免无声生效。 */
export function lengthExemptions(): ReadonlyMap<string, string> {
  return EXEMPT_FILES;
}

/** 测试文件不参与行数门禁：夹具与断言密度高不等于职责混杂。 */
export function isTestSourcePath(filePath: string): boolean {
  return /(^|\/)tests?\//.test(filePath) || /\.test\.[cm]?[jt]sx?$/.test(filePath);
}

/** 统计行数：末尾换行不额外计一行，CRLF 与 LF 结果一致。 */
export function countSourceLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
  return trimmed.split("\n").length;
}

/** 检查全部非测试源码文件的行数；超限按文件路径升序报告，便于逐条审计。 */
export function checkSourceFileLengths(
  files: readonly BoundarySourceFile[],
  limit: number = SOURCE_FILE_LINE_LIMIT,
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of files) {
    if (isLengthExemptPath(file.path)) {
      continue;
    }
    const lines = countSourceLines(file.content);
    if (lines <= limit) {
      continue;
    }
    violations.push({
      rule: RULE_SOURCE_HEADER,
      code: "source-file-too-long",
      file: file.path,
      line: limit + 1,
      message: `源文件共 ${lines} 行，超过 ${limit} 行上限；按职责拆分文件，不要继续加长。`,
    });
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file));
}
