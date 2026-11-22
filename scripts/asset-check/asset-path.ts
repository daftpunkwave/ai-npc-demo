/**
 * 核心职责：校验资产路径位于 assets/ 之内并验证本地文件存在、非空且未越出真实路径。
 * 交互契约：输入为清单声明的相对路径与仓库根；违规写入违规集合并返回 null。
 * 约束与禁忌：拒绝绝对路径、盘符、URL 协议、上级目录与符号链接越界。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 路径已限制在 assets/ 内并做过 realpath 越界检查。 */
import { realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AssetViolation } from "./report-types";

const ASSETS_DIRECTORY = "assets";

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

export function verifyLocalFile(
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
