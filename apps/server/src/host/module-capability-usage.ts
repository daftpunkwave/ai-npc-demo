/**
 * 核心职责：静态对账模块描述符的 provides/requires 与模块源码实际访问的能力端口。
 * 交互契约：只读取仓库 modules 目录下的手写源码与已登记模块定义，不执行模块代码、不访问存储；
 * 对账结果交给目录预检汇总，供 `pnpm check:catalog` 在启动前发现漏声明、多余声明与拼写错误。
 * 约束与禁忌：不按模块 ID 猜测实现、不跳过读不到源码的模块，也不把能力访问限制成运行期才暴露的问题。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ModuleDefinition } from "@ai-npc/contracts";

/** 一条源码能力访问与声明不一致的违规。 */
export interface CapabilityUsageViolation {
  readonly file: string;
  readonly code: string;
  readonly message: string;
}

/**
 * 能力 ID 的访问形态：`["game.world"]`、`context.ports["platform.storage"]` 等。
 * 要求左方括号前是标识符、`)` 或 `]`，避免把 `requiresRemote: ["platform.x"]` 这类声明数组当成访问。
 * 浏览器 realm 通过 client-sdk 的 `usePort` 取端口，不走索引访问，因此只对 server 模块做源码对账。
 */
const capabilityAccessPattern =
  /(?<=[\w\])$])\s*\[\s*["']((?:game|platform|client|console|agent|transport)\.[a-z0-9-]+)["']\s*\]/g;

/** 一个模块源码目录及其对应的登记定义。 */
interface ModuleSource {
  readonly directory: string;
  readonly identifier: string;
  readonly definitions: readonly ModuleDefinition[];
  readonly files: readonly string[];
}

function isSkippedDirectory(name: string): boolean {
  return name === "node_modules" || name === "tests" || name.startsWith(".");
}

/** 收集 modules 下所有带 src/definition.ts 的模块目录。 */
function findModuleDirectories(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    const absolute = join(root, relative);
    const entries = readdirSync(absolute, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "definition.ts") && basename(relative) === "src") {
      found.push(resolve(root, relative, ".."));
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !isSkippedDirectory(entry.name)) {
        walk(`${relative}/${entry.name}`);
      }
    }
  };
  const modulesRoot = join(root, "modules");
  try {
    statSync(modulesRoot);
  } catch {
    return [];
  }
  walk("modules");
  return found.sort();
}

/** 按 workspace 目录规则把模块目录映射为模块 ID 前缀。 */
function moduleIdentifier(realm: string, directory: string): string | null {
  const parts = directory.split(/[\\/]/);
  const modulesIndex = parts.lastIndexOf("modules");
  if (modulesIndex === -1 || parts[modulesIndex + 1] !== realm) {
    return null;
  }
  const rest = parts.slice(modulesIndex + 2);
  const identifier = rest.join(".");
  return realm === "server" ? identifier : `${realm}.${identifier}`;
}

/** 读取模块 src 下的全部手写 TypeScript 文件。 */
function sourceFilesOf(directory: string): readonly string[] {
  const sourceDirectory = join(directory, "src");
  const files: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDirectory(entry.name)) {
          walk(child);
        }
      } else if (entry.isFile() && child.endsWith(".ts")) {
        files.push(child);
      }
    }
  };
  walk(sourceDirectory);
  return files.sort();
}

/** 抽取一个源码文件中按能力 ID 访问端口的行与能力名。 */
function capabilityAccesses(file: string): readonly { readonly capability: string; readonly line: number }[] {
  const accesses: { capability: string; line: number }[] = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const [index, text] of lines.entries()) {
    for (const match of text.matchAll(capabilityAccessPattern)) {
      const capability = match[1];
      if (capability !== undefined) {
        accesses.push({ capability, line: index + 1 });
      }
    }
  }
  return accesses;
}

/** 相对仓库根输出文件路径，保持诊断信息可定位且不泄漏本机绝对路径。 */
function displayPath(root: string, file: string): string {
  const relative = file.startsWith(root) ? file.slice(root.length + 1) : file;
  return relative.replaceAll("\\", "/");
}

/**
 * 对账全部模块源码访问的能力与其描述符声明。
 * - 访问了未在 provides/requires 中声明的能力：漏声明或拼写错误；
 * - requires 声明了但源码从未访问：多余声明；
 * - 模块目录没有对应登记定义，或定义没有对应源码目录：目录与 catalog 脱节。
 */
export function checkModuleCapabilityUsage(input: {
  readonly root: string;
  readonly definitions: readonly ModuleDefinition[];
}): readonly CapabilityUsageViolation[] {
  const root = resolve(input.root);
  const violations: CapabilityUsageViolation[] = [];
  const matchedDefinitionIds = new Set<string>();
  const modules: ModuleSource[] = [];

  for (const directory of findModuleDirectories(root)) {
    const relative = displayPath(root, directory);
    const parts = relative.split(/[\\/]/);
    const realm = parts[1];
    if (realm !== "server" && realm !== "client" && realm !== "console") {
      violations.push({
        file: relative,
        code: "module-realm",
        message: `模块目录 ${relative} 不在 server/client/console 三个 realm 下`,
      });
      continue;
    }
    const identifier = moduleIdentifier(realm, relative);
    if (identifier === null) {
      violations.push({
        file: relative,
        code: "module-directory",
        message: `模块目录 ${relative} 不符合 workspace 目录规则`,
      });
      continue;
    }
    const definitions = input.definitions.filter(
      (definition) => definition.realm === realm && (
        definition.id === identifier || definition.id.startsWith(`${identifier}-`)
      ),
    );
    if (definitions.length === 0) {
      // 尚未进入装配目录的模块（例如目标中的 Agent 模块）不参与对账，避免把“未登记目录”当成违规。
      continue;
    }
    for (const definition of definitions) {
      matchedDefinitionIds.add(definition.id);
    }
    if (realm !== "server") {
      continue;
    }
    modules.push({ directory: relative, identifier, definitions, files: sourceFilesOf(directory) });
  }

  for (const definition of input.definitions) {
    if (!matchedDefinitionIds.has(definition.id)) {
      violations.push({
        // eslint-disable-next-line xss/no-mixed-html -- "<module-catalog>" 是预检诊断的占位文件名，不是 HTML 片段。
        file: `<module-catalog>`,
        code: "module-source-missing",
        message: `模块 ${definition.id} 在 modules 目录下没有对应的源码包`,
      });
    }
  }

  const knownCapabilities = new Set<string>();
  for (const definition of input.definitions) {
    for (const provided of definition.provides) {
      knownCapabilities.add(provided.capability);
    }
    for (const required of definition.requires) {
      knownCapabilities.add(required.capability);
    }
  }

  for (const module of modules) {
    const accessed = new Set<string>();
    for (const file of module.files) {
      for (const access of capabilityAccesses(file)) {
        accessed.add(access.capability);
        if (!knownCapabilities.has(access.capability)) {
          violations.push({
            file: displayPath(root, file),
            code: "capability-unknown",
            message: `模块 ${module.identifier} 访问了目录中不存在的能力 ${access.capability}`,
          });
          continue;
        }
        const allowedBySome = module.definitions.some((definition) =>
          [...definition.provides, ...definition.requires].some(
            (reference) => reference.capability === access.capability,
          ),
        );
        if (!allowedBySome) {
          const owners = module.definitions.map((definition) => definition.id).join("、");
          violations.push({
            file: displayPath(root, file),
            code: "capability-undeclared",
            message:
              `模块 ${owners} 在 ${displayPath(root, file)}:${access.line} 访问了未声明的能力 ` +
              `${access.capability}；请补进 requires 或移除该访问`,
          });
        }
      }
    }
    for (const definition of module.definitions) {
      for (const required of definition.requires) {
        if (!accessed.has(required.capability)) {
          violations.push({
            file: module.directory,
            code: "capability-unused",
            message: `模块 ${definition.id} 声明了 requires ${required.capability}，但源码没有访问该能力`,
          });
        }
      }
    }
  }

  return violations;
}
