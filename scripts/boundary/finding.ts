/**
 * 构造、去重与排序边界违规记录。
 * 所有规则共用同一记录形状，CLI 与测试按文件、行号与规则编号稳定排序输出。
 * 禁止在此调整规则判定或吞掉重复记录之外的信息。
 */
import type { BoundaryRule, BoundaryViolation } from "./types";

export function violation(
  rule: BoundaryRule,
  code: string,
  file: string,
  line: number,
  message: string,
): BoundaryViolation {
  return { rule, code, file, line, message };
}

/** 同一规则、位置与说明只保留一条；随后按文件、行号、规则编号排序，保证输出稳定。 */
export function dedupeAndSort(violations: readonly BoundaryViolation[]): readonly BoundaryViolation[] {
  const seen = new Set<string>();
  const unique: BoundaryViolation[] = [];
  for (const item of violations) {
    const key = `${item.rule}|${item.code}|${item.file}|${item.line}|${item.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule - right.rule ||
      left.code.localeCompare(right.code),
  );
}
