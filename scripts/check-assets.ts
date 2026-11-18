/**
 * 校验世界资产包：manifest 可解析、文件存在、SVG 尺寸与描述完整、无脚本或远端引用。
 * 只读文件，不渲染、不访问网络。
 * 禁止把缺失/破损资产静默当作可用。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, "assets/manifest.json"), "utf8")) as Manifest;
if (manifest.schemaVersion !== 1 || manifest.assets.length === 0) {
  throw new Error("assets/manifest.json schemaVersion 或 assets 不合法");
}
const ids = new Set<string>();
for (const asset of manifest.assets) {
  if (ids.has(asset.assetId)) {
    throw new Error(`重复 assetId: ${asset.assetId}`);
  }
  ids.add(asset.assetId);
  const path = join(root, asset.path);
  if (!existsSync(path)) {
    throw new Error(`资产不存在: ${asset.path}`);
  }
  const text = readFileSync(path, "utf8");
  if (!text.includes(`viewBox="0 0 ${asset.width} ${asset.height}"`)) {
    throw new Error(`资产 viewBox 与 manifest 不一致: ${asset.path}`);
  }
  if (!text.includes("<title") || !text.includes("<desc")) {
    throw new Error(`资产缺少 title/desc: ${asset.path}`);
  }
  if (/<script|href="https?:|xlink:href="https?:/i.test(text)) {
    throw new Error(`资产包含脚本或远端引用: ${asset.path}`);
  }
}
console.info(`assets ok: ${manifest.assets.length} files`);
