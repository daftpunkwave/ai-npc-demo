/**
 * 核心职责：守卫命令网关注入 handler 上下文的两个属性各自独占一行，避免再次被合并成一行。
 * 交互契约：读取仓库内该源文件文本并按行断言；不执行源码、不依赖构建产物。
 * 约束与禁忌：只做排版结构断言，不校验业务逻辑；行为正确性由 handler-context 单元测试负责。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sourceUrl = new URL("../../packages/authority/src/command-gateway.ts", import.meta.url);

function sourceLines(): readonly string[] {
  return readFileSync(sourceUrl, "utf8").split(/\r?\n/);
}

/** 找到 handler 上下文构造所在的 `modules:` 行号；缺失说明该段被重写，测试需要同步更新。 */
function modulesLineIndex(lines: readonly string[]): number {
  const index = lines.findIndex((line) => line.includes("modules: this.bindModules("));
  expect(index, "未找到命令网关的 modules 属性行").toBeGreaterThanOrEqual(0);
  return index;
}

describe("命令网关 handler 上下文的属性排版", () => {
  it("modules 与 content 各自独占一行", () => {
    const lines = sourceLines();
    const modulesIndex = modulesLineIndex(lines);
    const modulesLine = lines[modulesIndex] ?? "";
    const contentLine = lines[modulesIndex + 1] ?? "";

    expect(modulesLine.trimEnd().endsWith(","), `modules 行未以逗号结束：${modulesLine}`).toBe(true);
    expect(modulesLine).not.toContain("content:");
    expect(contentLine.trim()).toBe("content: this.content,");
  });

  it("其余属性同样保持每行一个，不出现合并写法", () => {
    const lines = sourceLines();
    const modulesIndex = modulesLineIndex(lines);
    // 从 modules 行起连续读取到对象字面量结束，逐行确认不含第二个属性键。
    const block: string[] = [];
    for (let index = modulesIndex; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      block.push(line);
      if (line.trim() === "});") {
        break;
      }
    }
    expect(block.length).toBeGreaterThan(1);
    const squashed = block.filter((line) => (line.match(/\b[a-zA-Z]+:/g) ?? []).length > 1);
    expect(squashed, `以下行包含多个属性：\n${squashed.join("\n")}`).toEqual([]);
  });
});
