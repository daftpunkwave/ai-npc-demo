/**
 * 校验世界资产包：manifest 可解析、文件存在、SVG 结构合法、尺寸与描述完整、无脚本/事件/远端引用。
 * 只读固定资产文件，不渲染、不访问网络。
 * 禁止把缺失/破损资产静默当作可用。
 */
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

interface AssetEntry {
  readonly assetId: string;
  readonly kind: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

interface Manifest {
  readonly schemaVersion: number;
  readonly assets: readonly AssetEntry[];
}

const sources = new Map<string, string>([
  ["assets/world/grayharbor-relay.svg", readFileSync("assets/world/grayharbor-relay.svg", "utf8")],
  ["assets/world/old-watergate.svg", readFileSync("assets/world/old-watergate.svg", "utf8")],
  ["assets/world/ash-orchard.svg", readFileSync("assets/world/ash-orchard.svg", "utf8")],
  ["assets/world/migration-pass.svg", readFileSync("assets/world/migration-pass.svg", "utf8")],
  ["assets/world/archive-vault.svg", readFileSync("assets/world/archive-vault.svg", "utf8")],
  ["assets/world/landing-anchor.svg", readFileSync("assets/world/landing-anchor.svg", "utf8")],
  ["assets/factions/ember-compact.svg", readFileSync("assets/factions/ember-compact.svg", "utf8")],
  ["assets/factions/earthborn-pact.svg", readFileSync("assets/factions/earthborn-pact.svg", "utf8")],
  ["assets/factions/ceasefire-circle.svg", readFileSync("assets/factions/ceasefire-circle.svg", "utf8")],
  ["assets/factions/far-star-assembly.svg", readFileSync("assets/factions/far-star-assembly.svg", "utf8")],
  ["assets/factions/grayharbor-commune.svg", readFileSync("assets/factions/grayharbor-commune.svg", "utf8")],
  ["assets/factions/wandering-kin.svg", readFileSync("assets/factions/wandering-kin.svg", "utf8")],
  ["assets/factions/root-court.svg", readFileSync("assets/factions/root-court.svg", "utf8")],
  ["assets/factions/starfarers.svg", readFileSync("assets/factions/starfarers.svg", "utf8")],
]);

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", isArray: (name) => ["title", "desc", "script"].includes(name) });

function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item)).filter((item) => item !== null).join(" ").trim() || null;
  }
  if (typeof value === "object" && value !== null) {
    const text = (value as Record<string, unknown>)["#text"];
    return textOf(text);
  }
  return null;
}

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
      const href = String(value).toLowerCase();
      if (href.startsWith("//") || href.startsWith("http:") || href.startsWith("https:") || href.startsWith("data:")) {
        throw new Error(`资产包含远端引用 ${href}: ${path}`);
      }
    }
    if (key === "@style" && /url\s*\(/i.test(String(value))) {
      throw new Error(`资产 CSS 包含 url(): ${path}`);
    }
    assertSafe(value, path);
  }
}

const manifest = JSON.parse(readFileSync("assets/manifest.json", "utf8")) as Manifest;
if (manifest.schemaVersion !== 1 || manifest.assets.length === 0) {
  throw new Error("assets/manifest.json schemaVersion 或 assets 不合法");
}
const ids = new Set<string>();
for (const asset of manifest.assets) {
  if (ids.has(asset.assetId)) {
    throw new Error(`重复 assetId: ${asset.assetId}`);
  }
  ids.add(asset.assetId);
  const source = sources.get(asset.path);
  if (source === undefined) {
    throw new Error(`资产未登记到校验表或不存在: ${asset.path}`);
  }
  const parsed = parser.parse(source) as Record<string, unknown>;
  const svg = parsed["svg"] as Record<string, unknown> | undefined;
  if (svg === undefined) {
    throw new Error(`根元素不是 svg: ${asset.path}`);
  }
  if (svg["@viewBox"] !== `0 0 ${asset.width} ${asset.height}`) {
    throw new Error(`资产 viewBox 与 manifest 不一致: ${asset.path}`);
  }
  if (textOf(svg["title"]) === null || textOf(svg["desc"]) === null) {
    throw new Error(`资产缺少 title/desc: ${asset.path}`);
  }
  assertSafe(svg, asset.path);
}
console.info(`assets ok: ${manifest.assets.length} files`);
