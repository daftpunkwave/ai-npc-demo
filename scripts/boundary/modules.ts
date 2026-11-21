/**
 * 模块包的目录解析、kind 读取与 realm/kind 依赖白名单计算。
 * 白名单按 adapter 所属适配器细化，未知适配器只获得基础白名单。
 * 禁止按“纯工具库”或“适配器身份”扩大白名单，或对读不到 kind 的模块静默放行。
 */
import {
  BROWSER_MODULE_WORKSPACE_DEPENDENCIES,
  RULE_MODULE_REALM,
  SERVER_MODULE_WORKSPACE_DEPENDENCIES,
} from "./constants";
import { violation } from "./finding";
import { isModulePackageName, nodeBuiltinName, packageNameOfSpecifier } from "./paths";
import type {
  AdapterExtras,
  BoundaryPackage,
  BoundarySourceFile,
  BoundaryViolation,
  DependencyAllowlist,
  ModuleKind,
  ModulePackageInfo,
  ModulePathInfo,
} from "./types";

const NO_ADAPTER_EXTRAS: AdapterExtras = { external: [], externalPrefixes: [], nodeBuiltins: [] };

/** 按目录段解析模块包位置；路径深度不符合 workspace 目录规则时返回 null。 */
export function parseModuleDirectory(directory: string): ModulePathInfo | null {
  const segments = directory.split("/");
  if (segments[0] !== "modules") {
    return null;
  }
  const realm = segments[1];
  if (realm !== "server" && realm !== "client" && realm !== "console") {
    return null;
  }
  const expectedSegments = realm === "server" ? 5 : 4;
  if (segments.length !== expectedSegments) {
    return null;
  }
  const rest = segments.slice(2);
  const implementation = rest[rest.length - 1] ?? "";
  return { realm, identifier: rest.join("."), implementation };
}

function serverAdapterExtras(modulePath: ModulePathInfo): AdapterExtras {
  switch (modulePath.identifier) {
    case "transport.http-ws.fastify":
      // 传输层用 node:crypto 的 timingSafeEqual 比较身份、会话与票据令牌。
      return {
        external: ["fastify"],
        externalPrefixes: ["@fastify/"],
        nodeBuiltins: ["node:crypto"],
      };
    case "platform.storage.sqlite":
      return {
        external: [],
        externalPrefixes: [],
        nodeBuiltins: ["node:sqlite", "node:fs", "node:path", "node:url"],
      };
    case "platform.model-transport.anthropic":
      return { external: ["@anthropic-ai/sdk"], externalPrefixes: [], nodeBuiltins: [] };
    case "platform.model-transport.openai-compatible":
      return NO_ADAPTER_EXTRAS;
    default:
      return NO_ADAPTER_EXTRAS;
  }
}

/** 按 realm/kind 计算模块包允许的 workspace 入口、第三方库与 Node 内置模块。 */
export function dependencyAllowlist(modulePath: ModulePathInfo, kind: ModuleKind): DependencyAllowlist {
  if (modulePath.realm === "server") {
    const extras = kind === "adapter" ? serverAdapterExtras(modulePath) : NO_ADAPTER_EXTRAS;
    return {
      workspace: SERVER_MODULE_WORKSPACE_DEPENDENCIES,
      external: ["zod", ...extras.external],
      externalPrefixes: extras.externalPrefixes,
      nodeBuiltins: extras.nodeBuiltins,
    };
  }

  const browserExtras =
    kind === "adapter" && modulePath.identifier === "scene-renderer.pixi"
      ? { external: ["pixi.js"] }
      : { external: [] };
  return {
    workspace: BROWSER_MODULE_WORKSPACE_DEPENDENCIES,
    external: ["zod", "react", ...browserExtras.external],
    externalPrefixes: [],
    nodeBuiltins: [],
  };
}

export function isAllowedNodeBuiltin(specifier: string, allowed: readonly string[]): boolean {
  const name = nodeBuiltinName(specifier);
  if (name === null) {
    return false;
  }
  return allowed.includes(name) || allowed.includes(specifier);
}

/** 从模块 definition 源文本读取 kind；读不到时由调用方注入覆盖或明确报错。 */
export function readDefinitionKind(files: readonly BoundarySourceFile[], directory: string): ModuleKind | null {
  const definitionPath = `${directory}/src/definition.ts`;
  const definitionFile = files.find((file) => file.path === definitionPath);
  if (definitionFile === undefined) {
    return null;
  }
  const match = /kind\s*:\s*["'](service|contributor|adapter)["']/.exec(definitionFile.content);
  const value = match?.[1];
  return value === "service" || value === "contributor" || value === "adapter" ? value : null;
}

/** 规则 2：按模块包的 realm/kind 白名单检查 dependencies 声明。 */
export function checkModuleManifests(
  packages: readonly BoundaryPackage[],
  modulePackages: ReadonlyMap<string, ModulePackageInfo>,
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const [packageName, moduleInfo] of modulePackages) {
    if (moduleInfo.kind === null) {
      continue;
    }
    const pkg = packages.find((candidate) => candidate.name === packageName);
    if (pkg === undefined) {
      continue;
    }
    const allowlist = dependencyAllowlist(moduleInfo.path, moduleInfo.kind);
    const manifestPath = `${pkg.directory}/package.json`;
    for (const dependencyName of Object.keys(pkg.dependencies)) {
      if (dependencyName.startsWith("@ai-npc/")) {
        if (isModulePackageName(dependencyName)) {
          violations.push(
            violation(
              RULE_MODULE_REALM,
              "module-cross-package-dependency",
              manifestPath,
              1,
              `模块包之间不能互相依赖：dependencies 声明了 ${dependencyName}。`,
            ),
          );
          continue;
        }
        if (!allowlist.workspace.includes(dependencyName)) {
          violations.push(
            violation(
              RULE_MODULE_REALM,
              "module-forbidden-declared-dependency",
              manifestPath,
              1,
              `${moduleInfo.path.realm}/${moduleInfo.kind} 模块不允许声明 workspace 依赖 ${dependencyName}。`,
            ),
          );
        }
        continue;
      }
      const packageBase = packageNameOfSpecifier(dependencyName);
      const allowed =
        allowlist.external.includes(packageBase) ||
        allowlist.externalPrefixes.some((prefix) => packageBase.startsWith(prefix));
      if (!allowed) {
        violations.push(
          violation(
            RULE_MODULE_REALM,
            "module-unlisted-declared-dependency",
            manifestPath,
            1,
            `${moduleInfo.path.realm}/${moduleInfo.kind} 模块的 dependencies 声明了白名单外依赖 ${dependencyName}。`,
          ),
        );
      }
    }
  }
  return violations;
}
