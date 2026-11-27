/**
 * 核心职责：静态对账模块描述符的 provides/requires 与模块源码实际访问的能力端口。
 * 交互契约：只读取仓库 modules 目录下的手写源码与已登记模块定义，不执行模块代码、不访问存储；
 * 源码中的能力访问由能力扫描器逐文件抽取，对账结果交给目录预检汇总，
 * 供 `pnpm check:catalog` 在启动前发现漏声明、多余声明、拼写错误与无法静态对账的动态能力键。
 * 约束与禁忌：不按模块 ID 猜测实现、不跳过读不到源码的模块，也不把能力访问限制成运行期才暴露的问题；
 * 服务端模块生产源码以非字面量键读取端口容器（如 `ports[variable]`、`{ [key]: port } = context.modules`）
 * 直接报 `capability-dynamic-key`，不为动态键设放行名单，保证每处能力访问都能与 requires 对账。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModuleDefinition } from "@world-prism/contracts";
import { capabilityAccesses } from "./module-capability-scanner";
import { findModuleDirectories, moduleIdentifier, sourceFilesOf, type ModuleSource } from "./module-sources";

/** 一条源码能力访问与声明不一致的违规。 */
export interface CapabilityUsageViolation {
  readonly file: string;
  readonly code: string;
  readonly message: string;
}

/** 相对仓库根输出文件路径，保持诊断信息可定位且不泄漏本机绝对路径。 */
function displayPath(root: string, file: string): string {
  const relative = file.startsWith(root) ? file.slice(root.length + 1) : file;
  return relative.replaceAll("\\", "/");
}

/**
 * 对账全部模块源码访问的能力与其描述符声明。
 * - 访问了未在 provides/requires 中声明的能力：漏声明或拼写错误；
 * - 访问处写了能力 group 前缀但语法不符合契约：能力 ID 语法错误，描述符阶段同样会拒绝；
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
        (definition.sourceModuleId ?? definition.id) === identifier ||
        (definition.sourceModuleId ?? definition.id).startsWith(`${identifier}-`)
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
      for (const access of capabilityAccesses(readFileSync(file, "utf8"))) {
        const relativeFile = displayPath(root, file);
        if (access.kind === "dynamic-key") {
          const owners = module.definitions.map((definition) => definition.id).join("、");
          violations.push({
            file: relativeFile,
            code: "capability-dynamic-key",
            message:
              `模块 ${owners} 在 ${relativeFile}:${access.line} 用非字面量键读取端口容器 ${access.receiver}，` +
              "无法与 requires 静态对账；请改为写死能力 ID 的引号字面量，如 ports[\"game.world\"]",
          });
          continue;
        }
        if (!access.valid) {
          const owners = module.definitions.map((definition) => definition.id).join("、");
          violations.push({
            file: relativeFile,
            code: "capability-invalid",
            message:
              `模块 ${owners} 在 ${relativeFile}:${access.line} 写下的能力 ID ${access.value} 不符合语法 ` +
              "<group>.<family>；family 只含小写字母、数字与连字符",
          });
          continue;
        }
        accessed.add(access.value);
        if (!knownCapabilities.has(access.value)) {
          violations.push({
            file: relativeFile,
            code: "capability-unknown",
            message: `模块 ${module.identifier} 访问了目录中不存在的能力 ${access.value}`,
          });
          continue;
        }
        const allowedBySome = module.definitions.some((definition) =>
          [...definition.provides, ...definition.requires].some(
            (reference) => reference.capability === access.value,
          ),
        );
        if (!allowedBySome) {
          const owners = module.definitions.map((definition) => definition.id).join("、");
          violations.push({
            file: relativeFile,
            code: "capability-undeclared",
            message:
              `模块 ${owners} 在 ${relativeFile}:${access.line} 访问了未声明的能力 ` +
              `${access.value}；请补进 requires 或移除该访问`,
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
