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
      // 非字符串值无法判定协议（String(对象) 会得到 "[object Object]" 并被误判为相对路径），直接拒绝。
      if (typeof value !== "string") {
        throw new Error(`资产引用不是字符串 ${key}: ${path}`);
      }
      // 控制字符与反斜杠会改变浏览器的 URL 解析：形如 "java\tscript:" 或 "\evil.com/x"
      // 的原始值不匹配协议前缀，却会在解析时折叠成 javascript: 或协议相对地址。
      // 解析器不解码 XML 实体，因此 "java&#9;script:" 会原样保留；浏览器渲染时才解码，
      // 所以字符引用同样必须拒绝，否则白名单会被绕过。
      if (/[\u0000-\u001f\u007f\\]/u.test(value) || /&#(?:x0*[0-9a-f]+|0*\d+);/iu.test(value)) {
        throw new Error(`资产引用包含控制字符、字符引用或反斜杠 ${key}: ${path}`);
      }
      const href = value.trim().toLowerCase();
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
