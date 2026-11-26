/**
 * 验证文档检查命令对 Markdown 表格、相对链接和锚点的诊断与退出码。
 * 使用隔离的临时文档目录，依赖 scripts 对外导出的 CLI 入口。
 * 禁止修改仓库文档或让测试依赖真实文档的数量。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDocsCheckCli } from "@world-prism/scripts/check-docs";

function checkFixture(markdown: readonly string[], serverReadme: readonly string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "world-prism-docs-check-"));
  try {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "apps/server"), { recursive: true });
    writeFileSync(join(root, "docs/fixture.md"), markdown.join("\n"), "utf8");
    writeFileSync(join(root, "apps/server/README.md"), serverReadme.join("\n"), "utf8");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = runDocsCheckCli({
      root,
      writeStdout: (message) => { stdout.push(message); },
      writeStderr: (message) => { stderr.push(message); },
    });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("保留转义竖线，识别偶数反斜杠后的分隔符，并忽略围栏内的表格", () => {
  const result = checkFixture([
    "# 指南",
    "",
    "| 名称 | 内容 |",
    "| :--- | ---: |",
    "| `a\\|b` | **x\\|y** |",
    "| 路径\\\\| 值 |",
    "",
    "````markdown",
    "```",
    "| 一 | 二 |",
    "| --- |",
    "[围栏内的链接](missing.md)",
    "```",
    "````",
  ], ["[指南](../../docs/fixture.md#指南)"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("检查 1 张 Markdown 表格");
  expect(result.stdout).toContain("检查 1 条相对链接");
  expect(result.stderr).toBe("");
});

it("在紧接表格的标题、列表、引用和分隔线处结束表格", () => {
  const table = ["| 名称 | 内容 |", "| --- | --- |", "| A | B |"];
  const blocks = ["## 标题 | 一 | 二", "- 列表 | 一 | 二", "1. 有序列表 | 一 | 二", "> 引用 | 一 | 二", "* * *"];
  const result = checkFixture(blocks.flatMap((block) => [...table, block, ""]));
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("检查 5 张 Markdown 表格");
  expect(result.stderr).toBe("");
});

it("报告表头、少列、多列以及无分隔符的数据行", () => {
  const result = checkFixture([
    "| 名称 | 内容 |",
    "| --- |",
    "",
    "| 名称 | 内容 |",
    "| --- | --- |",
    "| A |",
    "| A | B | C |",
    "只有一列",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("发现 4 行表格列数错误");
  expect(result.stderr).toContain("docs/fixture.md:1 期望 1 列，实际 2 列");
  expect(result.stderr).toContain("docs/fixture.md:6 期望 2 列，实际 1 列");
  expect(result.stderr).toContain("docs/fixture.md:7 期望 2 列，实际 3 列");
  expect(result.stderr).toContain("docs/fixture.md:8 期望 2 列，实际 1 列");
});

it("扫描服务端 README，报告缺失的相对链接和锚点", () => {
  const result = checkFixture(["# 指南"], [
    "[错误的锚点](../../docs/fixture.md#不存在)",
    "[错误的路径](../../docs/missing.md)",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/README.md:1 -> ../../docs/fixture.md#不存在（目标标题锚点不存在）");
  expect(result.stderr).toContain("apps/server/README.md:2 -> ../../docs/missing.md（目标文件不存在）");
});

it("接受更长的结束围栏并继续检查后续的链接、标题和表格", () => {
  const result = checkFixture([
    "```markdown",
    "| 一 | 二 |",
    "| --- |",
    "````",
    "## 围栏以后",
    "[坏链接](missing.md)",
    "",
    "| 一 | 二 |",
    "| --- | --- |",
    "| 少一列 |",
  ], ["[围栏以后](../../docs/fixture.md#围栏以后)"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("检查 1 张 Markdown 表格");
  expect(result.stderr).toContain("发现 1 条坏链接");
  expect(result.stderr).toContain("docs/fixture.md:6 -> missing.md");
  expect(result.stderr).toContain("docs/fixture.md:10 期望 2 列，实际 1 列");
});

it("验证引用内的表格，按引用层级分隔表格并跳过引用里的代码围栏", () => {
  const result = checkFixture([
    "| 一 | 二 |",
    "| --- | --- |",
    "> 说明 | 一 | 二 | 三",
    ">",
    "> > | 一 | 二 |",
    "> > | --- | --- |",
    "> > | 少一列 |",
    "> >",
    "> > ```markdown",
    "> > | 一 | 二 |",
    "> > | --- |",
    "> > ```",
    "",
    "| 一 | 二 |",
    "| --- | --- |",
    "| 可通过 | 二 |",
  ]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("检查 3 张 Markdown 表格");
  expect(result.stderr).toContain("发现 1 行表格列数错误");
  expect(result.stderr).toContain("docs/fixture.md:7 期望 2 列，实际 1 列");
});
