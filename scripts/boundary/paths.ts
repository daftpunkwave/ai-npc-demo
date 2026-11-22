/**
 * 仓库相对路径与模块说明符的分类工具。
 * 统一路径写法供包归属判断复用，避免 Windows 分隔符与跨包相对路径误判。
 * 禁止在此读取文件或决定白名单，只做纯字符串与路径计算。
 */
import { dirname, join } from "node:path";
import {
  BROWSER_REALM_DIRECTORY_PREFIXES,
  HOST_MECHANISM_DIRECTORY_PREFIXES,
  NODE_BUILTIN_NAMES,
  SKIPPED_DIRECTORY_NAMES,
} from "./constants";

/** 统一仓库内相对路径写法，避免 Windows 分隔符影响包归属与前缀判断。 */
export function normalizeRepoPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

export function isSkippedDirectory(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(name);
}

export function isSkippedPath(filePath: string): boolean {
  return filePath.split("/").some((segment) => isSkippedDirectory(segment));
}

export function lineAt(source: string, index: number): number {
  let line = 1;
  const limit = Math.min(index, source.length);
  for (let position = 0; position < limit; position += 1) {
    // eslint-disable-next-line security/detect-object-injection -- 字符下标来自本文件循环。
    if (source[position] === "\n") {
      line += 1;
    }
  }
  return line;
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

/** 解析相对导入的目标路径；越出仓库根目录时返回 null。 */
export function resolveRelativePath(fromFile: string, specifier: string): string | null {
  const resolved = normalizeRepoPath(join(dirname(fromFile), specifier));
  if (resolved === ".." || resolved.startsWith("../")) {
    return null;
  }
  return resolved;
}

/** 取导入说明符对应的包名，用于依赖声明与白名单判断。 */
export function packageNameOfSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0] ?? ""}/${parts[1] ?? ""}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

export function nodeBuiltinName(specifier: string): string | null {
  if (specifier.startsWith("node:")) {
    return specifier;
  }
  const base = specifier.split("/")[0] ?? "";
  return NODE_BUILTIN_NAMES.has(base) ? base : null;
}

export function isModulePackageName(name: string): boolean {
  return name.startsWith("@ai-npc/mod-");
}

/** vite.config.ts、vitest.config.ts 等工具入口：配置构建与测试工具，不是生产实现。 */
export function isToolConfigFile(filePath: string): boolean {
  const fileName = filePath.split("/").pop() ?? "";
  return /^\w+\.config\.[cm]?[jt]sx?$/.test(fileName);
}

export function isApplicationFile(filePath: string): boolean {
  return filePath.startsWith("apps/");
}

export function isModuleCatalogFile(filePath: string): boolean {
  return /^apps\/[^/]+\/src\/host\/module-catalog\.(?:ts|tsx)$/.test(filePath);
}

export function isBrowserRealmFile(filePath: string): boolean {
  return BROWSER_REALM_DIRECTORY_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

export function isHostMechanismFile(filePath: string): boolean {
  return HOST_MECHANISM_DIRECTORY_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}
