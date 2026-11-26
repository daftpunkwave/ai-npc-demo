/**
 * 核心职责：校验非测试源码行数门禁的判定：超限报告、测试与迁移豁免、豁免表需带理由。
 * 交互契约：把夹具字符串直接交给 `checkSourceFileLengths` 纯函数，不读取真实仓库文件。
 * 约束与禁忌：不断言具体阈值数字之外的实现细节，也不通过在夹具里堆积无关代码绕过规则。
 */
import { describe, expect, it } from "vitest";
import {
  SOURCE_FILE_LINE_LIMIT,
  checkSourceFileLengths,
  countSourceLines,
  lengthExemptions,
} from "@world-prism/scripts/check-boundaries";

/** 生成指定行数的文件内容，每行是一条无害语句。 */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `const value${index} = ${index};`).join("\n") + "\n";
}

describe("规则 7：源文件行数上限", () => {
  it("恰好等于上限时不报违规，超过一行即报违规", () => {
    const atLimit = checkSourceFileLengths([
      { path: "apps/server/src/host/at-limit.ts", content: lines(SOURCE_FILE_LINE_LIMIT) },
    ]);
    expect(atLimit).toEqual([]);

    const overLimit = checkSourceFileLengths([
      { path: "apps/server/src/host/over-limit.ts", content: lines(SOURCE_FILE_LINE_LIMIT + 1) },
    ]);
    expect(overLimit).toHaveLength(1);
    expect(overLimit[0]).toMatchObject({
      code: "source-file-too-long",
      file: "apps/server/src/host/over-limit.ts",
      line: SOURCE_FILE_LINE_LIMIT + 1,
    });
    expect(overLimit[0]?.message).toContain(String(SOURCE_FILE_LINE_LIMIT + 1));
  });

  it("末尾换行不额外计一行，CRLF 与 LF 行数一致", () => {
    expect(countSourceLines("a\nb\n")).toBe(2);
    expect(countSourceLines("a\nb")).toBe(2);
    expect(countSourceLines("a\r\nb\r\n")).toBe(2);
    expect(countSourceLines("")).toBe(0);
  });

  it("测试文件与已发布迁移不参与行数门禁", () => {
    const violations = checkSourceFileLengths([
      { path: "tests/integration/huge.test.ts", content: lines(SOURCE_FILE_LINE_LIMIT + 50) },
      { path: "modules/server/platform/storage/sqlite/migrations/0001_init.sql", content: lines(SOURCE_FILE_LINE_LIMIT + 50) },
      { path: "apps/server/src/host/huge-file.test.ts", content: lines(SOURCE_FILE_LINE_LIMIT + 50) },
    ]);
    expect(violations).toEqual([]);
  });

  it("文件级豁免必须带理由，且只豁免列出的文件", () => {
    const exemptions = lengthExemptions();
    expect(exemptions.size).toBeGreaterThan(0);
    for (const [file, reason] of exemptions) {
      expect(file.length, file).toBeGreaterThan(0);
      // 理由必须是能独立读懂的中文说明，而不是空串或占位符。
      expect(reason.length, file).toBeGreaterThan(10);
    }
  });

  it("超限文件按路径升序报告，便于逐条审计", () => {
    const violations = checkSourceFileLengths([
      { path: "modules/zeta/src/a.ts", content: lines(SOURCE_FILE_LINE_LIMIT + 1) },
      { path: "apps/alpha/src/b.ts", content: lines(SOURCE_FILE_LINE_LIMIT + 1) },
    ]);
    expect(violations.map((violation) => violation.file)).toEqual([
      "apps/alpha/src/b.ts",
      "modules/zeta/src/a.ts",
    ]);
  });
});
