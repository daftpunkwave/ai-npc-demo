/**
 * 核心职责：解析 SVG 资产并校验根元素、viewBox、无障碍描述与内容安全结构。
 * 交互契约：输入为已读取的 SVG 源文本与清单声明的尺寸；违规写入违规集合。
 * 约束与禁忌：禁止接受 script 元素、事件处理器、远端引用与 CSS url()，禁止渲染 SVG。
 */
import { XMLParser } from "fast-xml-parser";
import type { AssetViolation } from "./report-types";
import { isRecord, textOf } from "./parsing";

/* eslint-disable no-unused-vars -- 类型与回调参数名用于表达调用契约。 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => ["title", "desc", "script"].includes(name),
});

function assertSafe(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      assertSafe(item, path);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "script") {
      throw new Error(`资产包含 script: ${path}`);
    }
    if (key.startsWith("@on")) {
      throw new Error(`资产包含事件处理器 ${key}: ${path}`);
    }
    if (key === "@href" || key.endsWith(":href")) {
      const href = String(value).trim().toLowerCase();
      // 只允许文档内片段引用与不带协议的相对路径：白名单式判断才能同时排除
      // javascript:/vbscript:/file: 等可执行或本地协议，以及协议相对 //host。
      const safe = href.startsWith("#") || (!href.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/u.test(href));
      if (!safe) {
        throw new Error(`资产包含不允许的引用 ${href}: ${path}`);
      }
    }
    if (key === "@style" && /url\s*\(/i.test(String(value))) {
      throw new Error(`资产 CSS 包含 url(): ${path}`);
    }
    assertSafe(value, path);
  }
}

export function readDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function validateSvg(
  source: string,
  relativePath: string,
  assetId: string | null,
  width: number | null,
  height: number | null,
  violations: AssetViolation[],
): void {
  const label = `${assetId ?? "资产"}（${relativePath}）`;
  let parsed: unknown;
  try {
    parsed = parser.parse(source) as unknown;
  } catch {
    violations.push({ code: "asset-parse", message: `SVG 无法解析：${label}` });
    return;
  }
  const svg = isRecord(parsed) ? parsed["svg"] : undefined;
  if (!isRecord(svg)) {
    violations.push({ code: "asset-root", message: `根元素不是 svg：${label}` });
    return;
  }
  if (width !== null && height !== null && svg["@viewBox"] !== `0 0 ${width} ${height}`) {
    violations.push({ code: "asset-viewbox", message: `viewBox 应为 0 0 ${width} ${height}：${label}` });
  }
  if (svg["@role"] !== "img") {
    violations.push({ code: "asset-role", message: `SVG 缺少 role="img"：${label}` });
  }
  if (textOf(svg["title"]) === null) {
    violations.push({ code: "asset-title", message: `SVG 缺少非空 title：${label}` });
  }
  if (textOf(svg["desc"]) === null) {
    violations.push({ code: "asset-desc", message: `SVG 缺少非空 desc：${label}` });
  }
  try {
    assertSafe(svg, relativePath);
  } catch (error) {
    violations.push({
      code: "asset-unsafe",
      message: error instanceof Error ? error.message : `SVG 结构不安全：${label}`,
    });
  }
}
