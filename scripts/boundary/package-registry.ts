/**
 * 包归属、公开入口与跨包引用判定的查询工具。
 * 只做纯查询：包目录前缀匹配、exports 入口声明、验证包与测试文件识别。
 * 禁止在此读取文件系统或重新解释依赖白名单。
 */
import {
  BROWSER_FORBIDDEN_EXTERNAL_PREFIXES,
  BROWSER_FORBIDDEN_EXTERNALS,
  HOST_MECHANISM_FORBIDDEN_EXTERNAL_PREFIXES,
  HOST_MECHANISM_FORBIDDEN_EXTERNALS,
  SERVER_ONLY_WORKSPACE_PACKAGES,
} from "./constants";
import { packageNameOfSpecifier } from "./paths";
import type { BoundaryPackage, CheckContext, WorkspaceImportResolution } from "./types";

export function isVerificationPackage(pkg: BoundaryPackage): boolean {
  return pkg.name === "@ai-npc/tests" || pkg.name === "@ai-npc/scripts";
}

export function isTestFile(filePath: string, pkg: BoundaryPackage): boolean {
  const relativeToPackage = filePath.slice(pkg.directory.length + 1);
  if (relativeToPackage === "tests" || relativeToPackage.startsWith("tests/")) {
    return true;
  }
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

/**
 * 判定依据：验证包（tests、scripts）与测试文件只为验证引用公开入口，
 * 按公开约定豁免 dependencies 声明要求；深层导入、循环依赖与生产源码边界仍照常检查。
 */
export function canCheckDependencyDeclaration(pkg: BoundaryPackage, testFile: boolean): boolean {
  return !isVerificationPackage(pkg) && !testFile;
}

export function findOwningPackage(
  filePath: string,
  packagesBySpecificity: readonly BoundaryPackage[],
): BoundaryPackage | undefined {
  return packagesBySpecificity.find(
    (pkg) => filePath === pkg.directory || filePath.startsWith(`${pkg.directory}/`),
  );
}

/** 解析 workspace 包导入：取最长包名前缀，返回目标包与未声明入口的子路径。 */
export function resolveWorkspaceImport(
  specifier: string,
  packagesByName: ReadonlyMap<string, BoundaryPackage>,
): WorkspaceImportResolution {
  let longest = "";
  for (const name of packagesByName.keys()) {
    if ((specifier === name || specifier.startsWith(`${name}/`)) && name.length > longest.length) {
      longest = name;
    }
  }
  const fallbackBase = packageNameOfSpecifier(specifier);
  if (longest === "") {
    return { target: undefined, base: fallbackBase, subpath: null };
  }
  const target = packagesByName.get(longest);
  const rest = specifier.slice(longest.length);
  return {
    target,
    base: longest,
    subpath: rest.startsWith("/") ? rest.slice(1) : null,
  };
}

/** 判断 exports 是否声明了子路径入口；支持带 * 的通配入口。 */
export function isExportDeclared(exports: Readonly<Record<string, string>>, subpath: string): boolean {
  if (Object.prototype.hasOwnProperty.call(exports, subpath)) {
    return true;
  }
  for (const key of Object.keys(exports)) {
    const star = key.indexOf("*");
    if (star === -1) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

/** 浏览器 realm 禁止引用的服务端专用 workspace 包，含服务端模块与宿主应用。 */
export function isServerOnlyWorkspacePackage(name: string, context: CheckContext): boolean {
  if (SERVER_ONLY_WORKSPACE_PACKAGES.has(name)) {
    return true;
  }
  if (name.startsWith("@ai-npc/app-")) {
    return true;
  }
  if (name.startsWith("@ai-npc/mod-")) {
    const pkg = context.packagesByName.get(name);
    return pkg === undefined || pkg.directory.startsWith("modules/server/");
  }
  return false;
}

export function isBrowserForbiddenExternal(packageBase: string): boolean {
  return (
    BROWSER_FORBIDDEN_EXTERNALS.has(packageBase) ||
    BROWSER_FORBIDDEN_EXTERNAL_PREFIXES.some((prefix) => packageBase.startsWith(prefix))
  );
}

export function isHostMechanismForbiddenExternal(packageBase: string): boolean {
  return (
    HOST_MECHANISM_FORBIDDEN_EXTERNALS.has(packageBase) ||
    HOST_MECHANISM_FORBIDDEN_EXTERNAL_PREFIXES.some((prefix) => packageBase.startsWith(prefix))
  );
}
