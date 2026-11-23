/**
 * 规则 6 的包依赖图检查：未使用的 workspace 与第三方依赖声明、根清单生产依赖与循环依赖。
 * 图节点来自 dependencies 声明与生产源码实际引用，devDependencies 不构成运行时边。
 * 禁止把验证包的测试覆盖依赖算作生产使用，或跳过环检测。
 */
import { RULE_DEPENDENCY_GRAPH } from "./constants";
import { violation } from "./finding";
import { isRootPackage, isVerificationPackage } from "./package-registry";
import type { BoundaryPackage, BoundaryViolation } from "./types";

export function checkDependencyGraph(
  packages: readonly BoundaryPackage[],
  productionImports: ReadonlyMap<string, ReadonlySet<string>>,
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const knownNames = new Set(packages.map((pkg) => pkg.name));
  const edges = new Map<string, Set<string>>();

  const addEdge = (from: string, to: string): void => {
    if (from === to || !knownNames.has(to)) {
      return;
    }
    const targets = edges.get(from) ?? new Set<string>();
    targets.add(to);
    edges.set(from, targets);
  };

  for (const pkg of packages) {
    for (const dependencyName of Object.keys(pkg.dependencies)) {
      addEdge(pkg.name, dependencyName);
    }
    for (const importedName of productionImports.get(pkg.name) ?? []) {
      addEdge(pkg.name, importedName);
    }
  }

  // 验证包的 workspace 依赖用于测试自身覆盖，不计入生产引用，workspace 声明豁免 unused 检查；
  // 第三方声明对其照常检查（生产与测试源码的导入都计入使用）。
  // 根包没有生产源码，任何 dependencies 声明都无使用方，运行时职责应落在应用与模块包。
  for (const pkg of packages) {
    const verificationWorkspaceExempt = isVerificationPackage(pkg) && !isRootPackage(pkg);
    const imported = productionImports.get(pkg.name) ?? new Set<string>();
    for (const dependencyName of Object.keys(pkg.dependencies)) {
      const isWorkspaceDependency = dependencyName.startsWith("@ai-npc/");
      const exempt = verificationWorkspaceExempt && isWorkspaceDependency;
      if (!exempt && !imported.has(dependencyName)) {
        violations.push(
          violation(
            RULE_DEPENDENCY_GRAPH,
            isWorkspaceDependency ? "unused-workspace-dependency" : "unused-third-party-dependency",
            `${pkg.directory}/package.json`,
            1,
            isWorkspaceDependency
              ? `dependencies 声明了 workspace 依赖 ${dependencyName}，但生产源码没有引用它。`
              : `dependencies 声明了第三方依赖 ${dependencyName}，但生产源码没有引用它。`,
          ),
        );
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (name: string): void => {
    state.set(name, "visiting");
    stack.push(name);
    for (const target of edges.get(name) ?? []) {
      if (state.get(target) === "visiting") {
        const cycleStart = stack.indexOf(target);
        const cycle = [...stack.slice(cycleStart), target];
        const signature = [...new Set(cycle)].sort().join("|");
        if (!reported.has(signature)) {
          reported.add(signature);
          const firstPackage = packages.find((pkg) => pkg.name === target);
          violations.push(
            violation(
              RULE_DEPENDENCY_GRAPH,
              "cyclic-package-dependency",
              `${firstPackage?.directory ?? target}/package.json`,
              1,
              `包依赖出现环：${cycle.join(" -> ")}。`,
            ),
          );
        }
      } else if (state.get(target) !== "visited") {
        visit(target);
      }
    }
    stack.pop();
    state.set(name, "visited");
  };

  for (const pkg of [...packages].sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.get(pkg.name) !== "visited") {
      visit(pkg.name);
    }
  }

  return violations;
}
