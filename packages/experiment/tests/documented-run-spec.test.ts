/**
 * 验证平台配置文档里的 RunSpec 权威示例可以原样通过加载与交叉校验。
 * 依赖真实仓库配置、内容包与文档正文；只读文件，不打开存储或启动模块。
 * 禁止在此另写一份规格副本：断言必须针对文档中真实存在的代码块，否则文档失效时测试仍会通过。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContentPack, loadRoster, runSpecSchema, validateRunSpec } from "../src/index";
import { parseYamlText } from "../src/loading/yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loadContext = { configDir: resolve(repoRoot, "config"), env: process.env };
const content = loadContentPack(resolve(repoRoot, "content"), "earth-2964-v1");
const configurationDoc = resolve(repoRoot, "docs/platform/configuration.md");

/**
 * 取文档中第一个 fenced yaml 代码块。文档用 `~~~` 作围栏，
 * 因此按行首围栏匹配，而不是假设固定的反引号数量。
 */
function firstYamlBlock(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^(?:```|~~~)ya?ml\s*$/u.test(line));
  if (start === -1) {
    throw new Error("配置文档缺少 yaml 代码块");
  }
  const fence = /^(?:```|~~~)/u.exec(lines[start] ?? "")?.[0];
  if (fence === undefined) {
    throw new Error("无法识别代码块围栏");
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith(fence));
  if (end === -1) {
    throw new Error("配置文档的 yaml 代码块未闭合");
  }
  return lines.slice(start + 1, end).join("\n");
}

describe("配置文档的 RunSpec 权威示例", () => {
  it("文档中的 RunSpec 代码块原样通过 schema 与内容交叉校验", () => {
    const spec = firstYamlBlock(readFileSync(configurationDoc, "utf8"));

    const parsed = runSpecSchema.safeParse(parseYamlText(spec, configurationDoc));
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(`文档示例未通过 schema：${JSON.stringify(parsed.error.issues)}`);
    }
    // 示例必须是可创建的完整 RunSpec，而不是片段：缺字段会在上面就已失败。
    expect(parsed.data.id).toBe("watergate-memory-ledger");
    const roster = loadRoster(parsed.data.rosterRef, loadContext as never);
    expect(() => validateRunSpec(parsed.data, content, roster)).not.toThrow();
  });
});
