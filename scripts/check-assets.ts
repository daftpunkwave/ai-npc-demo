/**
 * 校验世界资产包：manifest 结构、SVG 安全结构与描述、清单与内容包六节点/八派系互相覆盖、kind 与 ID 对应及版本一致。
 * 只读取 assets/ 与 earth-2964-v1 内容包，不渲染、不访问网络；CLI 失败时以非零状态退出并逐项打印原因。
 * 禁止把缺失、破损或未覆盖的资产静默当作可用，也禁止接受 assets/ 之外的路径。
 */
import { readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { parse as parseYaml } from "yaml";

const CONTENT_PACK_DIRECTORY = "content/world-packs/earth-2964-v1";
const ASSETS_DIRECTORY = "assets";
const MANIFEST_PATH = "assets/manifest.json";
const EXPECTED_NODE_COUNT = 6;
const EXPECTED_FACTION_COUNT = 8;

export interface AssetViolation {
  readonly code: string;
  readonly message: string;
}

export interface AssetCheckReport {
  readonly assetCount: number;
  readonly nodeCount: number;
  readonly factionCount: number;
  readonly violations: readonly AssetViolation[];
}

export interface AssetCheckOptions {
  readonly root?: string;
}

export interface AssetCliOptions extends AssetCheckOptions {
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

/** 现有清单用 kind 区分地点卡与徽记，assetId 前缀与之一一对应，并各自指向地图节点或派系。 */
interface KindRule {
  readonly idPrefix: string;
  readonly targetField: "nodeId" | "factionId";
}

const KIND_RULES: Readonly<Record<string, KindRule>> = {
  location: { idPrefix: "world.", targetField: "nodeId" },
  emblem: { idPrefix: "faction.", targetField: "factionId" },
};

interface ContentPack {
  readonly packId: string;
  readonly contentVersion: string;
  readonly nodeIds: ReadonlySet<string>;
  readonly factionIds: ReadonlySet<string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => ["title", "desc", "script"].includes(name),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(
  root: string,
  relativePath: string,
  code: string,
  label: string,
  violations: AssetViolation[],
): string | null {
  try {
    return readFileSync(resolve(root, relativePath), "utf8");
  } catch {
    violations.push({ code, message: `${label}无法读取：${relativePath}` });
    return null;
  }
}

function parseJson(text: string, label: string, violations: AssetViolation[]): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    violations.push({ code: "manifest-unreadable", message: `${label}不是合法 JSON` });
    return null;
  }
}

function parseYamlText(text: string, label: string, violations: AssetViolation[]): unknown | null {
  try {
    return parseYaml(text) as unknown;
  } catch {
    violations.push({ code: "pack-unreadable", message: `${label}不是合法 YAML` });
    return null;
  }
}

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

function readIdentifierList(
  root: string,
  fileName: string,
  listField: string,
  idField: string,
  expectedCount: number,
  countCode: string,
  duplicateCode: string,
  label: string,
  violations: AssetViolation[],
): ReadonlySet<string> | null {
  const relativePath = `${CONTENT_PACK_DIRECTORY}/${fileName}`;
  const text = readText(root, relativePath, "pack-unreadable", `内容包 ${fileName}`, violations);
  if (text === null) {
    return null;
  }
  const value = parseYamlText(text, `内容包 ${fileName}`, violations);
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    violations.push({ code: "pack-invalid", message: `内容包 ${fileName} 根节点必须是映射` });
    return null;
  }
  if (value["schemaVersion"] !== 1) {
    violations.push({ code: "pack-invalid", message: `内容包 ${fileName} schemaVersion 必须为 1` });
    return null;
  }
  const list = value[listField];
  if (!Array.isArray(list)) {
    violations.push({ code: "pack-invalid", message: `内容包 ${fileName} 缺少数组 ${listField}` });
    return null;
  }
  const ids = new Set<string>();
  for (const [index, item] of list.entries()) {
    if (!isRecord(item)) {
      violations.push({ code: "pack-invalid", message: `内容包 ${fileName} ${listField}[${index}] 必须是映射` });
      continue;
    }
    const rawId = item[idField];
    if (typeof rawId !== "string" || rawId.trim() === "") {
      violations.push({ code: "pack-invalid", message: `内容包 ${fileName} ${listField}[${index}] 缺少非空字符串 ${idField}` });
      continue;
    }
    if (ids.has(rawId)) {
      violations.push({ code: duplicateCode, message: `内容包 ${fileName} 重复 ${idField}：${rawId}` });
    }
    ids.add(rawId);
  }
  if (list.length !== expectedCount) {
    violations.push({
      code: countCode,
      message: `内容包 ${fileName} 应包含 ${expectedCount} 个${label}，实际 ${list.length} 个`,
    });
  }
  return ids;
}

function loadContentPack(root: string, violations: AssetViolation[]): ContentPack | null {
  const relativePath = `${CONTENT_PACK_DIRECTORY}/pack.yaml`;
  const text = readText(root, relativePath, "pack-unreadable", "内容包 pack.yaml", violations);
  if (text === null) {
    return null;
  }
  const value = parseYamlText(text, "内容包 pack.yaml", violations);
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml 根节点必须是映射" });
    return null;
  }
  if (value["schemaVersion"] !== 1) {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml schemaVersion 必须为 1" });
    return null;
  }
  const packId = value["packId"];
  if (typeof packId !== "string" || packId.trim() === "") {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml 缺少非空 packId" });
    return null;
  }
  const contentVersion = value["contentVersion"];
  if (typeof contentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(contentVersion)) {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml 的 contentVersion 必须形如 1.0.0" });
    return null;
  }
  if (packId !== basename(CONTENT_PACK_DIRECTORY)) {
    violations.push({
      code: "pack-id-mismatch",
      message: `内容包目录名 ${basename(CONTENT_PACK_DIRECTORY)} 与 pack.yaml 的 packId ${packId} 不一致`,
    });
  }
  const nodeIds = readIdentifierList(
    root,
    "map.yaml",
    "nodes",
    "nodeId",
    EXPECTED_NODE_COUNT,
    "node-count",
    "node-duplicate",
    "节点",
    violations,
  );
  const factionIds = readIdentifierList(
    root,
    "factions.yaml",
    "factions",
    "factionId",
    EXPECTED_FACTION_COUNT,
    "faction-count",
    "faction-duplicate",
    "派系",
    violations,
  );
  if (nodeIds === null || factionIds === null) {
    return null;
  }
  return { packId, contentVersion, nodeIds, factionIds };
}

/** 资产路径必须是 assets/ 下的本地相对路径，拒绝绝对路径、盘符、URL 协议与上级目录。 */
function isAllowedAssetPath(value: string): boolean {
  if (value.length === 0 || isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || !value.startsWith(`${ASSETS_DIRECTORY}/`)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function verifyLocalFile(
  root: string,
  relativePath: string,
  label: string,
  scope: "asset" | "preview",
  violations: AssetViolation[],
): string | null {
  if (!isAllowedAssetPath(relativePath)) {
    violations.push({
      code: `${scope}-path`,
      message: `${label}路径必须位于 assets/ 下且使用本地相对路径：${relativePath}`,
    });
    return null;
  }
  const assetsRoot = resolve(root, ASSETS_DIRECTORY);
  const absolute = resolve(root, relativePath);
  const relativeToAssets = relative(assetsRoot, absolute);
  if (relativeToAssets === "" || relativeToAssets.startsWith("..") || isAbsolute(relativeToAssets)) {
    violations.push({ code: `${scope}-path`, message: `${label}路径越出 assets/：${relativePath}` });
    return null;
  }
  let fileStats: Stats;
  try {
    fileStats = statSync(absolute);
  } catch {
    violations.push({ code: `${scope}-missing`, message: `${label}文件不存在：${relativePath}` });
    return null;
  }
  if (!fileStats.isFile()) {
    violations.push({ code: `${scope}-missing`, message: `${label}不是普通文件：${relativePath}` });
    return null;
  }
  if (fileStats.size === 0) {
    violations.push({ code: `${scope}-empty`, message: `${label}文件为空：${relativePath}` });
    return null;
  }
  try {
    const realAssetsRoot = realpathSync(assetsRoot);
    const realFile = realpathSync(absolute);
    const realRelative = relative(realAssetsRoot, realFile);
    if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) {
      violations.push({ code: `${scope}-path`, message: `${label}通过符号链接越出 assets/：${relativePath}` });
      return null;
    }
  } catch {
    violations.push({ code: `${scope}-missing`, message: `${label}无法解析真实路径：${relativePath}` });
    return null;
  }
  return absolute;
}

function readDimension(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function validateSvg(
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

function addTarget(targets: Map<string, string[]>, targetId: string, assetId: string): void {
  const existing = targets.get(targetId);
  if (existing === undefined) {
    targets.set(targetId, [assetId]);
  } else {
    existing.push(assetId);
  }
}

function checkPreview(
  root: string,
  entry: Record<string, unknown>,
  label: string,
  violations: AssetViolation[],
): void {
  const preview = entry["preview"];
  if (preview === undefined) {
    return;
  }
  if (typeof preview !== "string" || preview.trim() === "") {
    violations.push({ code: "preview-path", message: `${label} 的 preview 必须是非空字符串` });
    return;
  }
  verifyLocalFile(root, preview, `${label} 预览`, "preview", violations);
}

/**
 * 读取并校验资产清单、内容包与全部声明文件。
 * 违规会累积返回而不是中途抛出，便于一次报告所有缺口；调用方据 violations 决定退出码。
 */
export function checkAssets(options: AssetCheckOptions = {}): AssetCheckReport {
  const root = resolve(options.root ?? process.cwd());
  const violations: AssetViolation[] = [];
  const content = loadContentPack(root, violations);
  const summary = (assetCount: number): AssetCheckReport => ({
    assetCount,
    nodeCount: content?.nodeIds.size ?? 0,
    factionCount: content?.factionIds.size ?? 0,
    violations,
  });

  const manifestText = readText(root, MANIFEST_PATH, "manifest-unreadable", "资产清单", violations);
  if (manifestText === null) {
    return summary(0);
  }
  const parsedManifest = parseJson(manifestText, "资产清单", violations);
  if (parsedManifest === null) {
    return summary(0);
  }
  if (!isRecord(parsedManifest)) {
    violations.push({ code: "manifest-schema", message: "资产清单根节点必须是对象" });
    return summary(0);
  }
  if (parsedManifest["schemaVersion"] !== 1) {
    violations.push({ code: "manifest-schema", message: "资产清单 schemaVersion 必须为 1" });
    return summary(0);
  }
  const rawAssets = parsedManifest["assets"];
  if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
    violations.push({ code: "manifest-schema", message: "资产清单 assets 必须是非空数组" });
    return summary(0);
  }

  const manifestPackId = parsedManifest["packId"];
  const manifestContentVersion = parsedManifest["contentVersion"];
  if (typeof manifestPackId !== "string" || manifestPackId.trim() === "") {
    violations.push({ code: "manifest-pack-id", message: "资产清单缺少非空 packId" });
  }
  if (typeof manifestContentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(manifestContentVersion)) {
    violations.push({ code: "manifest-content-version", message: "资产清单的 contentVersion 必须形如 1.0.0" });
  }
  if (content !== null) {
    if (manifestPackId !== content.packId) {
      violations.push({
        code: "pack-id-mismatch",
        message: `资产清单 packId（${String(manifestPackId)}）与内容包 pack.yaml（${content.packId}）不一致`,
      });
    }
    if (manifestContentVersion !== content.contentVersion) {
      violations.push({
        code: "version-mismatch",
        message: `资产清单 contentVersion（${String(manifestContentVersion)}）与内容包 pack.yaml（${content.contentVersion}）不一致`,
      });
    }
  }

  const seenAssetIds = new Set<string>();
  const seenPaths = new Set<string>();
  const nodeAssets = new Map<string, string[]>();
  const factionAssets = new Map<string, string[]>();

  for (const [index, rawAsset] of rawAssets.entries()) {
    const label = `资产清单第 ${index + 1} 项`;
    if (!isRecord(rawAsset)) {
      violations.push({ code: "asset-invalid", message: `${label}必须是对象` });
      continue;
    }
    const rawAssetId = rawAsset["assetId"];
    const assetId = typeof rawAssetId === "string" && rawAssetId.trim() !== "" ? rawAssetId : null;
    if (assetId === null) {
      violations.push({ code: "asset-invalid", message: `${label}缺少非空字符串 assetId` });
    } else if (seenAssetIds.has(assetId)) {
      violations.push({ code: "asset-duplicate-id", message: `重复 assetId：${assetId}` });
    } else {
      seenAssetIds.add(assetId);
    }
    const display = assetId ?? label;

    const description = rawAsset["description"];
    if (typeof description !== "string" || description.trim() === "") {
      violations.push({ code: "asset-description", message: `${display} 缺少非空 description` });
    }

    const rawKind = rawAsset["kind"];
    const kind = typeof rawKind === "string" && rawKind.trim() !== "" ? rawKind : null;
    if (kind === null) {
      violations.push({ code: "asset-invalid", message: `${display} 缺少非空字符串 kind` });
    }
    const rule = kind === null ? null : (KIND_RULES[kind] ?? null);
    if (kind !== null && rule === null) {
      violations.push({ code: "asset-kind-unknown", message: `${display} 的 kind 未定义：${kind}` });
    }
    if (assetId !== null && rule !== null && !assetId.startsWith(rule.idPrefix)) {
      violations.push({
        code: "asset-id-prefix",
        message: `${display} 的 kind=${kind} 要求 assetId 以 ${rule.idPrefix} 开头`,
      });
    }

    const width = readDimension(rawAsset["width"]);
    const height = readDimension(rawAsset["height"]);
    if (width === null) {
      violations.push({ code: "asset-size", message: `${display} 的 width 必须是正整数` });
    }
    if (height === null) {
      violations.push({ code: "asset-size", message: `${display} 的 height 必须是正整数` });
    }

    if (rule !== null) {
      const targetValue = rawAsset[rule.targetField];
      const targetId = typeof targetValue === "string" && targetValue.trim() !== "" ? targetValue : null;
      if (targetId === null) {
        violations.push({
          code: "asset-target",
          message: `${display} 的 kind=${kind} 必须声明非空 ${rule.targetField}`,
        });
      }
      if (rawAsset[rule.targetField === "nodeId" ? "factionId" : "nodeId"] !== undefined) {
        violations.push({
          code: "asset-target",
          message: `${display} 的 kind=${kind} 不应声明 ${rule.targetField === "nodeId" ? "factionId" : "nodeId"}`,
        });
      }
      if (targetId !== null && content !== null) {
        if (rule.targetField === "nodeId") {
          if (!content.nodeIds.has(targetId)) {
            violations.push({ code: "asset-node-unknown", message: `${display} 指向的节点不存在：${targetId}` });
          } else {
            addTarget(nodeAssets, targetId, display);
          }
        } else if (!content.factionIds.has(targetId)) {
          violations.push({ code: "asset-faction-unknown", message: `${display} 指向的派系不存在：${targetId}` });
        } else {
          addTarget(factionAssets, targetId, display);
        }
      }
    }

    const rawPath = rawAsset["path"];
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      violations.push({ code: "asset-invalid", message: `${display} 缺少非空字符串 path` });
    } else {
      if (seenPaths.has(rawPath)) {
        violations.push({ code: "asset-path-duplicate", message: `多个资产声明同一路径：${rawPath}` });
      } else {
        seenPaths.add(rawPath);
      }
      const absolute = verifyLocalFile(root, rawPath, `${display} 资产`, "asset", violations);
      if (absolute !== null) {
        let source: string | null = null;
        try {
          source = readFileSync(absolute, "utf8");
        } catch {
          violations.push({ code: "asset-read", message: `${display} 读取失败：${rawPath}` });
        }
        if (source !== null) {
          validateSvg(source, rawPath, assetId, width, height, violations);
        }
      }
    }

    checkPreview(root, rawAsset, display, violations);
  }

  if (content !== null) {
    for (const [nodeId, assets] of nodeAssets) {
      if (assets.length > 1) {
        violations.push({
          code: "asset-target-duplicate",
          message: `节点 ${nodeId} 被多个资产声明：${assets.join("、")}`,
        });
      }
    }
    for (const [factionId, assets] of factionAssets) {
      if (assets.length > 1) {
        violations.push({
          code: "asset-target-duplicate",
          message: `派系 ${factionId} 被多个资产声明：${assets.join("、")}`,
        });
      }
    }
    for (const nodeId of content.nodeIds) {
      if (!nodeAssets.has(nodeId)) {
        violations.push({ code: "node-uncovered", message: `节点 ${nodeId} 没有资产清单条目覆盖` });
      }
    }
    for (const factionId of content.factionIds) {
      if (!factionAssets.has(factionId)) {
        violations.push({ code: "faction-uncovered", message: `派系 ${factionId} 没有资产清单条目覆盖` });
      }
    }
  }

  return summary(rawAssets.length);
}

/** 输出校验结果并返回退出码；失败项逐行打印明确原因，成功时报告覆盖数量。 */
export function runAssetCheckCli(options: AssetCliOptions = {}): number {
  const report = checkAssets({ root: options.root });
  const writeStdout = options.writeStdout ?? ((text: string): void => {
    process.stdout.write(text);
  });
  const writeStderr = options.writeStderr ?? ((text: string): void => {
    process.stderr.write(text);
  });
  if (report.violations.length === 0) {
    writeStdout(`资产校验通过：${report.assetCount} 个 SVG，覆盖 ${report.nodeCount} 个节点、${report.factionCount} 个派系。\n`);
    return 0;
  }
  writeStderr(`资产校验失败：${report.violations.length} 项。\n`);
  for (const violation of report.violations) {
    writeStderr(`  [${violation.code}] ${violation.message}\n`);
  }
  return 1;
}

function isDirectExecution(moduleUrl: string): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) {
    return false;
  }
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolve(entryPath)) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === modulePath;
  }
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = runAssetCheckCli({ root: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
}
