/**
 * 校验世界资产包：manifest 可解析、文件存在、SVG 尺寸与描述完整、无脚本或远端引用。
 * 只读固定资产文件，不渲染、不访问网络。
 * 禁止把缺失/破损资产静默当作可用。
 */
import { readFileSync } from "node:fs";

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
  if (!source.includes(`viewBox="0 0 ${asset.width} ${asset.height}"`)) {
    throw new Error(`资产 viewBox 与 manifest 不一致: ${asset.path}`);
  }
  if (!/<title[\s>]/i.test(source) || !/<desc[\s>]/i.test(source)) {
    throw new Error(`资产缺少 title/desc: ${asset.path}`);
  }
  if (/<script|href="https?:|xlink:href="https?:/i.test(source)) {
    throw new Error(`资产包含脚本或远端引用: ${asset.path}`);
  }
}
console.info(`assets ok: ${manifest.assets.length} files`);
