/**
 * 边界检查器测试的共享夹具辅助：读取纯文本夹具、构造包清单并断言违规代码。
 * 依赖 Node 内置文件系统读取 fixtures、检查器公开导出与 vitest 断言。
 * 禁止在此放宽规则、跳过夹具或改变规则编号与断言的对应关系。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  checkSourceFile,
  type BoundaryPackage,
  type BoundaryViolation,
  type ModuleKindOverride,
} from "@world-prism/scripts/check-boundaries";

const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** 读取 fixtures 目录下的纯文本夹具内容。 */
export function readFixture(name: string): string {
  return readFileSync(join(fixturesDirectory, name), "utf8");
}

export interface PackageOptions {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, string>>;
}

/** 构造边界检查器所需的包清单视图，未声明字段保持为空。 */
export function packageManifest(name: string, directory: string, options: PackageOptions = {}): BoundaryPackage {
  return {
    name,
    directory,
    dependencies: options.dependencies ?? {},
    devDependencies: options.devDependencies ?? {},
    exports: options.exports ?? { ".": "./src/index.ts" },
  };
}

export const MEMORY_MODULE_NAME = "@world-prism/mod-agent-memory-ledger";
export const MEMORY_MODULE_DIRECTORY = "modules/server/agent/memory/ledger";
export const MEMORY_MODULE_KIND: ModuleKindOverride = { packageName: MEMORY_MODULE_NAME, kind: "service" };
export const SERVER_SERVICE_DIRECTORY = "modules/server/game/world/slg-light";
export const SERVER_SERVICE_PACKAGE = "@world-prism/mod-game-world-slg-light";
export const SERVER_SERVICE_KIND: ModuleKindOverride = { packageName: SERVER_SERVICE_PACKAGE, kind: "service" };

/** 记忆模块清单需要同时导出模块定义入口。 */
export function memoryModule(): BoundaryPackage {
  return packageManifest(MEMORY_MODULE_NAME, MEMORY_MODULE_DIRECTORY, {
    exports: { ".": "./src/index.ts", "./definition": "./src/definition.ts" },
  });
}

const basePackages: readonly BoundaryPackage[] = [
  packageManifest("@world-prism/contracts", "packages/contracts"),
  packageManifest("@world-prism/kernel", "packages/kernel"),
  packageManifest("@world-prism/module-sdk", "packages/module-sdk"),
  packageManifest("@world-prism/client-sdk", "packages/client-sdk"),
  packageManifest("@world-prism/client-protocol", "packages/client-protocol"),
  packageManifest("@world-prism/authority", "packages/authority"),
  packageManifest("@world-prism/experiment", "packages/experiment"),
  packageManifest("@world-prism/observability", "packages/observability"),
];

/** 合并基线包清单与用例覆盖项，同名包以后者为准。 */
export function packagesWith(overrides: readonly BoundaryPackage[] = []): readonly BoundaryPackage[] {
  const byName = new Map<string, BoundaryPackage>();
  for (const pkg of [...basePackages, ...overrides]) {
    byName.set(pkg.name, pkg);
  }
  return [...byName.values()];
}

export interface CheckOptions {
  readonly packages?: readonly BoundaryPackage[];
  readonly definitionKinds?: readonly ModuleKindOverride[];
}

/** 把夹具字符串交给检查器，返回违规列表而不写入磁盘。 */
export function checkFixture(path: string, fixture: string, options: CheckOptions = {}): readonly BoundaryViolation[] {
  return checkSourceFile({
    path,
    content: readFixture(fixture),
    packages: options.packages ?? packagesWith(),
    definitionKinds: options.definitionKinds ?? [],
  });
}

/** 仅按源码与路径检查文件头规则，不注入包清单。 */
export function checkHeader(path: string, fixture: string): readonly BoundaryViolation[] {
  return checkSourceFile({ path, content: readFixture(fixture) });
}

export function codesOf(violations: readonly BoundaryViolation[]): string[] {
  return violations.map((item) => item.code);
}

export function rulesOf(violations: readonly BoundaryViolation[]): number[] {
  return [...new Set(violations.map((item) => item.rule))];
}

export function expectCode(violations: readonly BoundaryViolation[], code: string): void {
  expect(codesOf(violations)).toContain(code);
}

export function expectRule(violations: readonly BoundaryViolation[], rule: number): void {
  expect(rulesOf(violations)).toContain(rule);
}
