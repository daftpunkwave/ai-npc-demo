/**
 * 边界检查编排：汇总模块元数据、逐文件执行 import 与文件头规则、再检查包清单与依赖图。
 * 纯函数入口不读写文件系统，夹具字符串与 CLI 扫描结果走同一条规则链。
 * 禁止在此放行无法判定 kind 的模块、跳过文件或改变规则编号。
 */
import { extname } from "node:path";
import { RULE_MODULE_REALM, SCRIPT_EXTENSIONS } from "./constants";
import { checkDefinitionFileImports, isModuleDefinitionFile } from "./definition";
import { checkDependencyGraph } from "./dependency-graph";
import { dedupeAndSort, violation } from "./finding";
import { checkFileHeader } from "./header";
import { inspectImport } from "./import-rules";
import { collectImports } from "./lexer";
import { checkModuleManifests, parseModuleDirectory, readDefinitionKind } from "./modules";
import {
  findOwningPackage,
  isTestFile,
  isVerificationPackage,
  resolveWorkspaceImport,
} from "./package-registry";
import { isSkippedPath, normalizeRepoPath } from "./paths";
import type {
  BoundaryCheckInput,
  BoundaryPackage,
  BoundarySourceFile,
  BoundaryViolation,
  CheckContext,
  ModulePackageInfo,
  SingleFileCheckInput,
} from "./types";

/** 纯检查入口：不读写文件系统，夹具字符串与 CLI 扫描结果走同一条规则链。 */
export function checkBoundaries(input: BoundaryCheckInput): readonly BoundaryViolation[] {
  const files: BoundarySourceFile[] = input.files.map((file) => ({
    path: normalizeRepoPath(file.path),
    content: file.content,
  }));
  const packages: BoundaryPackage[] = input.packages.map((pkg) => ({
    name: pkg.name,
    directory: normalizeRepoPath(pkg.directory),
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    exports: pkg.exports,
  }));
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const packagesBySpecificity = [...packages].sort(
    (left, right) => right.directory.length - left.directory.length || left.name.localeCompare(right.name),
  );
  const definitionKindOverrides = new Map(
    (input.definitionKinds ?? []).map((override) => [override.packageName, override.kind]),
  );
  const violations: BoundaryViolation[] = [];
  const modulePackages = new Map<string, ModulePackageInfo>();

  for (const pkg of packages) {
    const modulePath = parseModuleDirectory(pkg.directory);
    if (modulePath === null) {
      continue;
    }
    const kindSource = readDefinitionKind(files, pkg.directory);
    const kind = kindSource ?? definitionKindOverrides.get(pkg.name) ?? null;
    if (kind === null) {
      violations.push(
        violation(
          RULE_MODULE_REALM,
          "module-kind-unreadable",
          `${pkg.directory}/package.json`,
          1,
          `模块 ${pkg.name} 的 definition 源文本读不到 kind，调用方也未注入；不能静默跳过 realm/kind 白名单。`,
        ),
      );
    }
    modulePackages.set(pkg.name, { path: modulePath, kind });
  }

  const context: CheckContext = { packagesByName, packagesBySpecificity, modulePackages };
  const productionImports = new Map<string, Set<string>>();

  for (const file of files) {
    if (isSkippedPath(file.path)) {
      continue;
    }
    const extension = extname(file.path).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(extension)) {
      const importer = findOwningPackage(file.path, packagesBySpecificity);
      const testFile = importer !== undefined && isTestFile(file.path, importer);
      const importerModule = importer === undefined ? undefined : modulePackages.get(importer.name);
      const imports = collectImports(file.content);
      if (importer !== undefined && !testFile && !isVerificationPackage(importer)) {
        const imported = productionImports.get(importer.name) ?? new Set<string>();
        for (const record of imports) {
          if (record.kind === "dynamic-non-literal") {
            continue;
          }
          const resolution = resolveWorkspaceImport(record.specifier, packagesByName);
          if (resolution.target !== undefined) {
            imported.add(resolution.target.name);
          }
        }
        productionImports.set(importer.name, imported);
      }
      for (const record of imports) {
        violations.push(...inspectImport(file, importer, testFile, importerModule, context, record));
      }
      if (importerModule !== undefined && isModuleDefinitionFile(file.path, importer?.directory ?? "")) {
        violations.push(...checkDefinitionFileImports(file, imports));
      }
    }
    violations.push(...checkFileHeader(file.path, file.content));
  }

  violations.push(...checkModuleManifests(packages, modulePackages));
  violations.push(...checkDependencyGraph(packages, productionImports));
  return dedupeAndSort(violations);
}

/** 单文件检查入口：测试把夹具字符串直接传入，包清单与 kind 覆盖由调用方提供。 */
export function checkSourceFile(input: SingleFileCheckInput): readonly BoundaryViolation[] {
  return checkBoundaries({
    files: [{ path: input.path, content: input.content }],
    packages: input.packages ?? [],
    definitionKinds: input.definitionKinds ?? [],
  });
}
