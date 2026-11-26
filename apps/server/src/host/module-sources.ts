/**
 * 核心职责：发现 modules 目录下带 `src/definition.ts` 的模块目录，映射模块 ID 前缀并列出其手写源码。
 * 交互契约：输入仓库根目录或模块目录，返回排序后的路径集合；只读文件系统，不解析源码内容。
 * 约束与禁忌：不跳过读不到源码的模块、不按模块 ID 猜测实现，也不读取依赖目录与测试目录。
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ModuleDefinition } from "@ai-npc/contracts";

/** 一个模块源码目录及其对应的登记定义。 */
export interface ModuleSource {
  readonly directory: string;
  readonly identifier: string;
  readonly definitions: readonly ModuleDefinition[];
  readonly files: readonly string[];
}

export function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function isSkippedDirectory(name: string): boolean {
  return name === "node_modules" || name === "tests" || name.startsWith(".");
}

/** 收集 modules 下所有带 src/definition.ts 的模块目录。 */
export function findModuleDirectories(root: string): string[] {
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
  return found.sort((left, right) => left.localeCompare(right));
}

/** 按 workspace 目录规则把模块目录映射为模块 ID 前缀。 */
export function moduleIdentifier(realm: string, directory: string): string | null {
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
export function sourceFilesOf(directory: string): readonly string[] {
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
  return files.sort((left, right) => left.localeCompare(right));
}

/** 返回指定位置之前最近的代码字符，用于区分索引访问与声明数组。 */
function previousSignificantChar(text: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0 && isWhitespace(text[cursor])) {
    cursor -= 1;
  }
  return cursor < 0 ? "" : (text[cursor] ?? "");
}
