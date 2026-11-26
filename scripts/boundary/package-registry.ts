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

/** 根包目录为空串：它没有生产源码，只承载 workspace 编排与工具链配置。 */
export function isRootPackage(pkg: BoundaryPackage): boolean {
  return pkg.directory === "";
}

/** 验证包只有 tests 与 scripts：它们为验证用途引用依赖，可写在 devDependencies。 */
export function isVerificationPackage(pkg: BoundaryPackage): boolean {
  return pkg.name === "@world-prism/tests" || pkg.name === "@world-prism/scripts";
}

export function isTestFile(filePath: string, pkg: BoundaryPackage): boolean {
  // 根包目录为空串，去掉前缀时不能再多截一个字符，否则相对路径会丢掉首字母。
  const relativeToPackage = pkg.directory === "" ? filePath : filePath.slice(pkg.directory.length + 1);
  if (relativeToPackage === "tests" || relativeToPackage.startsWith("tests/")) {
    return true;
  }
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

/**
 * 判定依据：测试文件本身不是生产实现，其导入的 vitest 等工具由调用方 runtime 提供，整体豁免；
 * 其余源码（含验证包的生产性脚本代码）都要求目标包出现在自身清单里。
 * 「是否允许写在 devDependencies」由 {@link allowsDevDependencyDeclaration} 单独判定，
 * 不能把「允许引用范围更大」误解成「无需声明」。
 */
export function canCheckDependencyDeclaration(testFile: boolean): boolean {
  return !testFile;
}

/**
 * 第三方库不走公开入口约定，测试文件（*.test.ts 等）豁免；
 * 其余源码必须声明，判定同上。
 */
export function canCheckThirdPartyDeclaration(testFile: boolean): boolean {
  return !testFile;
}

/**
 * 验证包（tests、scripts）的源码只为验证用途引用依赖，允许其把 workspace 与第三方依赖
 * 写在 devDependencies；生产模块仍要求写在 dependencies。根包没有源码，不适用该放宽。
 */
export function allowsDevDependencyDeclaration(pkg: BoundaryPackage | undefined): boolean {
  return pkg !== undefined && isVerificationPackage(pkg) && pkg.directory !== "";
}

export function findOwningPackage(
  filePath: string,
  packagesBySpecificity: readonly BoundaryPackage[],
): BoundaryPackage | undefined {
  // 根包目录是空串：它拥有仓库中所有未被更具体包目录匹配的文件，
  // 直接拼 `${pkg.directory}/` 会得到 "/" 前缀，导致根目录文件被判为无归属而跳过全部检查。
  return packagesBySpecificity.find((pkg) =>
    pkg.directory === ""
      ? true
      : filePath === pkg.directory || filePath.startsWith(`${pkg.directory}/`),
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
  if (name.startsWith("@world-prism/app-")) {
    return true;
  }
  if (name.startsWith("@world-prism/mod-")) {
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
