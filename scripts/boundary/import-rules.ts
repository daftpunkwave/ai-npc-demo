/**
 * 规则 1–6 的 import 判定：按说明符类型分派到相对路径、workspace 包与第三方库检查。
 * 模块 realm/kind 白名单、浏览器边界、kernel/contracts 限制与应用组合根限制都在此汇总。
 * 禁止在此放行白名单外依赖、跳过深层导入或把测试豁免扩展到生产源码。
 */
import {
  RULE_BROWSER_REALM,
  RULE_COMPOSITION_ROOT,
  RULE_DEPENDENCY_GRAPH,
  RULE_HOST_MECHANISM,
  RULE_IMPORT_BOUNDARY,
  RULE_MODULE_REALM,
} from "./constants";
import { violation } from "./finding";
import { dependencyAllowlist, isAllowedNodeBuiltin } from "./modules";
import {
  canCheckDependencyDeclaration,
  findOwningPackage,
  isBrowserForbiddenExternal,
  isExportDeclared,
  isHostMechanismForbiddenExternal,
  isServerOnlyWorkspacePackage,
  resolveWorkspaceImport,
} from "./package-registry";
import {
  isApplicationFile,
  isBrowserRealmFile,
  isHostMechanismFile,
  isModuleCatalogFile,
  isModulePackageName,
  isRelativeSpecifier,
  nodeBuiltinName,
  packageNameOfSpecifier,
  resolveRelativePath,
} from "./paths";
import type {
  BoundaryPackage,
  BoundarySourceFile,
  BoundaryViolation,
  CheckContext,
  ImportRecord,
  ModulePackageInfo,
} from "./types";

function inspectRelativeImport(
  file: BoundarySourceFile,
  importer: BoundaryPackage | undefined,
  importerModule: ModulePackageInfo | undefined,
  context: CheckContext,
  record: ImportRecord,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const resolvedPath = resolveRelativePath(file.path, record.specifier);
  if (resolvedPath === null) {
    violations.push(
      violation(
        RULE_IMPORT_BOUNDARY,
        "cross-package-relative-import",
        file.path,
        record.line,
        "相对路径引用越出仓库根目录。",
      ),
    );
    return violations;
  }
  const target = findOwningPackage(resolvedPath, context.packagesBySpecificity);
  if (target === undefined || (importer !== undefined && target.name === importer.name)) {
    return violations;
  }
  violations.push(
    violation(
      RULE_IMPORT_BOUNDARY,
      "cross-package-relative-import",
      file.path,
      record.line,
      `相对路径引用进入其他包 ${target.name}，必须改用该包声明的公开入口。`,
    ),
  );
  if (importerModule !== undefined && isModulePackageName(target.name)) {
    violations.push(
      violation(
        RULE_MODULE_REALM,
        "module-cross-relative-import",
        file.path,
        record.line,
        `模块包之间不能通过相对路径互相引用（目标 ${target.name}）。`,
      ),
    );
  }
  if (isApplicationFile(file.path) && !isModuleCatalogFile(file.path) && isModulePackageName(target.name)) {
    violations.push(
      violation(
        RULE_COMPOSITION_ROOT,
        "module-import-outside-catalog",
        file.path,
        record.line,
        `应用组合根只允许 src/host/module-catalog.ts 引用模块包（目标 ${target.name}）。`,
      ),
    );
  }
  return violations;
}

function inspectWorkspaceImport(
  file: BoundarySourceFile,
  importer: BoundaryPackage | undefined,
  testFile: boolean,
  importerModule: ModulePackageInfo | undefined,
  context: CheckContext,
  record: ImportRecord,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const resolution = resolveWorkspaceImport(record.specifier, context.packagesByName);
  const target = resolution.target;

  if (target === undefined) {
    if (record.specifier.includes("/src/")) {
      violations.push(
        violation(
          RULE_IMPORT_BOUNDARY,
          "deep-import",
          file.path,
          record.line,
          `workspace 包深层路径导入 ${record.specifier}。`,
        ),
      );
    } else if (importer !== undefined && canCheckDependencyDeclaration(importer, testFile)) {
      violations.push(
        violation(
          RULE_IMPORT_BOUNDARY,
          "unknown-workspace-package",
          file.path,
          record.line,
          `引用了未在 workspace 中注册的包 ${record.specifier}。`,
        ),
      );
    }
    return violations;
  }

  if (resolution.subpath !== null && !isExportDeclared(target.exports, `./${resolution.subpath}`)) {
    violations.push(
      violation(
        RULE_IMPORT_BOUNDARY,
        "deep-import",
        file.path,
        record.line,
        `深层路径 ${record.specifier} 未由 ${target.name} 的 exports 声明。`,
      ),
    );
  }

  if (importer !== undefined && canCheckDependencyDeclaration(importer, testFile)) {
    if (!Object.prototype.hasOwnProperty.call(importer.dependencies, target.name)) {
      const devOnly = Object.prototype.hasOwnProperty.call(importer.devDependencies, target.name);
      violations.push(
        violation(
          RULE_IMPORT_BOUNDARY,
          devOnly ? "workspace-dependency-dev-only" : "workspace-dependency-not-declared",
          file.path,
          record.line,
          devOnly
            ? `${target.name} 只写在 devDependencies，生产源码依赖必须写入 dependencies。`
            : `引用了 ${target.name}，但它不在本包 dependencies 中。`,
        ),
      );
    }
  }

  if (importerModule !== undefined && importerModule.kind !== null) {
    const allowlist = dependencyAllowlist(importerModule.path, importerModule.kind);
    if (!allowlist.workspace.includes(target.name)) {
      violations.push(
        violation(
          RULE_MODULE_REALM,
          "module-forbidden-workspace-import",
          file.path,
          record.line,
          `${importerModule.path.realm}/${importerModule.kind} 模块不允许依赖 workspace 包 ${target.name}。`,
        ),
      );
    }
  }

  if (isBrowserRealmFile(file.path) && isServerOnlyWorkspacePackage(target.name, context)) {
    violations.push(
      violation(
        RULE_BROWSER_REALM,
        "browser-forbidden-server-package",
        file.path,
        record.line,
        `浏览器 realm 不能引用服务端专用包 ${target.name}。`,
      ),
    );
  }

  if (isHostMechanismFile(file.path) && (isModulePackageName(target.name) || target.name.startsWith("@ai-npc/app-"))) {
    violations.push(
      violation(
        RULE_HOST_MECHANISM,
        "host-mechanism-forbidden-import",
        file.path,
        record.line,
        `kernel/contracts 不能引用模块包或宿主应用 ${target.name}。`,
      ),
    );
  }

  if (isApplicationFile(file.path) && !isModuleCatalogFile(file.path) && isModulePackageName(target.name)) {
    violations.push(
      violation(
        RULE_COMPOSITION_ROOT,
        "module-import-outside-catalog",
        file.path,
        record.line,
        `应用组合根只允许 src/host/module-catalog.ts 引用模块包（目标 ${target.name}）。`,
      ),
    );
  }

  return violations;
}

function inspectExternalImport(
  file: BoundarySourceFile,
  importer: BoundaryPackage | undefined,
  testFile: boolean,
  importerModule: ModulePackageInfo | undefined,
  record: ImportRecord,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const builtin = nodeBuiltinName(record.specifier);

  if (builtin !== null) {
    if (importerModule !== undefined && importerModule.kind !== null) {
      const allowlist = dependencyAllowlist(importerModule.path, importerModule.kind);
      if (!isAllowedNodeBuiltin(record.specifier, allowlist.nodeBuiltins)) {
        violations.push(
          violation(
            RULE_MODULE_REALM,
            "module-forbidden-node-import",
            file.path,
            record.line,
            `${importerModule.path.realm}/${importerModule.kind} 模块不允许引用 Node 内置模块 ${record.specifier}。`,
          ),
        );
      }
    }
    if (isBrowserRealmFile(file.path)) {
      violations.push(
        violation(
          RULE_BROWSER_REALM,
          "browser-forbidden-node-import",
          file.path,
          record.line,
          `浏览器 realm 不能引用 Node 内置模块 ${record.specifier}。`,
        ),
      );
    }
    return violations;
  }

  const packageBase = packageNameOfSpecifier(record.specifier);

  if (importerModule !== undefined && importerModule.kind !== null) {
    const allowlist = dependencyAllowlist(importerModule.path, importerModule.kind);
    const allowed =
      allowlist.external.includes(packageBase) ||
      allowlist.externalPrefixes.some((prefix) => packageBase.startsWith(prefix));
    if (!allowed) {
      violations.push(
        violation(
          RULE_MODULE_REALM,
          "module-forbidden-external-import",
          file.path,
          record.line,
          `${importerModule.path.realm}/${importerModule.kind} 模块不允许引用第三方库 ${packageBase}。`,
        ),
      );
    }
  }

  if (isBrowserRealmFile(file.path) && isBrowserForbiddenExternal(packageBase)) {
    violations.push(
      violation(
        RULE_BROWSER_REALM,
        "browser-forbidden-external-import",
        file.path,
        record.line,
        `浏览器 realm 不能引用服务端专用库 ${packageBase}。`,
      ),
    );
  }

  if (isHostMechanismFile(file.path) && isHostMechanismForbiddenExternal(packageBase)) {
    violations.push(
      violation(
        RULE_HOST_MECHANISM,
        "host-mechanism-forbidden-import",
        file.path,
        record.line,
        `kernel/contracts 不能引用 ${packageBase}。`,
      ),
    );
  }

  if (importer !== undefined && canCheckDependencyDeclaration(importer, testFile)) {
    if (!Object.prototype.hasOwnProperty.call(importer.dependencies, packageBase)) {
      const devOnly = Object.prototype.hasOwnProperty.call(importer.devDependencies, packageBase);
      violations.push(
        violation(
          RULE_DEPENDENCY_GRAPH,
          devOnly ? "dependency-declared-in-dev-dependencies" : "undeclared-third-party-dependency",
          file.path,
          record.line,
          devOnly
            ? `${packageBase} 只写在 devDependencies，生产源码依赖必须写入 dependencies。`
            : `引用了未在 dependencies 声明的第三方库 ${packageBase}。`,
        ),
      );
    }
  }

  return violations;
}

/** 对一条 import 记录执行全部适用规则；非字面量动态导入单独按规则 6 处理。 */
export function inspectImport(
  file: BoundarySourceFile,
  importer: BoundaryPackage | undefined,
  testFile: boolean,
  importerModule: ModulePackageInfo | undefined,
  context: CheckContext,
  record: ImportRecord,
): readonly BoundaryViolation[] {
  if (record.kind === "dynamic-non-literal") {
    if (testFile) {
      return [];
    }
    return [
      violation(
        RULE_DEPENDENCY_GRAPH,
        "dynamic-import-non-literal",
        file.path,
        record.line,
        "生产源码出现非字面量动态导入，依赖目标无法静态校验。",
      ),
    ];
  }
  if (isRelativeSpecifier(record.specifier)) {
    return inspectRelativeImport(file, importer, importerModule, context, record);
  }
  if (record.specifier.startsWith("@ai-npc/")) {
    return inspectWorkspaceImport(file, importer, testFile, importerModule, context, record);
  }
  return inspectExternalImport(file, importer, testFile, importerModule, record);
}
