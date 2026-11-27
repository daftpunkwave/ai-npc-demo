/**
 * 边界检查编排：汇总模块元数据、逐文件执行 import 与文件头规则、再检查包清单、依赖图与共享契约唯一定义。
 * 纯函数入口不读写文件系统，夹具字符串与 CLI 扫描结果走同一条规则链。
 * 禁止在此放行无法判定 kind 的模块、跳过文件或改变规则编号。
 */
import { extname } from "node:path";
import { RULE_DEPENDENCY_GRAPH, RULE_MODULE_REALM, SCRIPT_EXTENSIONS } from "./constants";
import { checkDefinitionFileImports, isModuleDefinitionFile } from "./definition";
import { checkDependencyGraph } from "./dependency-graph";
import { checkSourceFileLengths } from "./file-length";
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
import { isSkippedPath, isToolConfigFile, nodeBuiltinName, normalizeRepoPath, packageNameOfSpecifier } from "./paths";
import { checkSharedContracts } from "./shared-contracts";
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
      const verificationImporter = importer !== undefined && isVerificationPackage(importer);
      // 工具入口（*.config.ts）的导入由 devDependencies 供给，不计入生产使用；
      // 验证包的全部源码（含测试）收集第三方导入，供依赖图检查验证包自身的声明。
      const toolConfigEntry = importer !== undefined && isToolConfigFile(file.path);
      if (importer !== undefined && !toolConfigEntry && (!testFile || verificationImporter)) {
        const imported = productionImports.get(importer.name) ?? new Set<string>();
        for (const record of imports) {
          if (record.kind === "dynamic-non-literal") {
            continue;
          }
          const resolution = resolveWorkspaceImport(record.specifier, packagesByName);
          if (resolution.target !== undefined) {
            if (!verificationImporter) {
              imported.add(resolution.target.name);
            }
            continue;
          }
          // 第三方导入也计入生产使用：dependencies 声明而源码未引用的库按依赖图规则报违规。
          if (nodeBuiltinName(record.specifier) === null) {
            imported.add(packageNameOfSpecifier(record.specifier));
          }
        }
        // .tsx/.jsx 经自动 JSX transform 隐式引入 react/jsx-runtime，视为事实使用 react；
        // 生产源码使用 JSX 而未声明 react 时按未声明第三方依赖报违规。
        if (!verificationImporter && /\.[jt]sx$/.test(extension)) {
          imported.add("react");
          if (!Object.prototype.hasOwnProperty.call(importer.dependencies, "react")) {
            violations.push(
              violation(
                RULE_DEPENDENCY_GRAPH,
                "undeclared-third-party-dependency",
                file.path,
                1,
                "自动 JSX transform 隐式依赖 react，须在 dependencies 声明。",
              ),
            );
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
  violations.push(...checkSourceFileLengths(files));
  violations.push(...checkSharedContracts(files, packagesBySpecificity));
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
