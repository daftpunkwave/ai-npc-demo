/**
 * 核心职责：读取并校验资产清单，覆盖清单结构、kind 与 ID 对应、路径文件与内容包互相覆盖。
 * 交互契约：依赖内容包加载、路径校验与 SVG 校验；违规累积返回而不是中途抛出。
 * 约束与禁忌：禁止把缺失、破损或未覆盖的资产静默当作可用。
 */
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- 路径已限制在 assets/ 与内容包目录内并做过 realpath 越界检查；kind 取值受规则表约束。 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadContentPack } from "./content-pack";
import { verifyLocalFile } from "./asset-path";
import { readDimension, validateSvg } from "./svg-safety";
import { isRecord, parseJson, readText } from "./parsing";
import type { AssetCheckOptions, AssetCheckReport, AssetViolation } from "./report-types";

const MANIFEST_PATH = "assets/manifest.json";

/** 现有清单用 kind 区分地点卡与徽记，assetId 前缀与之一一对应，并各自指向地图节点或派系。 */
interface KindRule {
  readonly idPrefix: string;
  readonly targetField: "nodeId" | "factionId";
}

const KIND_RULES: Readonly<Record<string, KindRule>> = {
  location: { idPrefix: "world.", targetField: "nodeId" },
  emblem: { idPrefix: "faction.", targetField: "factionId" },
};

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
