/**
 * 核心职责：静态对账模块描述符的 provides/requires 与模块源码实际访问的能力端口。
 * 交互契约：只读取仓库 modules 目录下的手写源码与已登记模块定义，不执行模块代码、不访问存储；
 * 对账结果交给目录预检汇总，供 `pnpm check:catalog` 在启动前发现漏声明、多余声明与拼写错误。
 * 约束与禁忌：不按模块 ID 猜测实现、不跳过读不到源码的模块，也不把能力访问限制成运行期才暴露的问题；
 * 只识别源码中写死能力 ID 的索引访问与对象键，动态键（如 `ports[variable]`）属于无法静态求值的形式，不在此检查。
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
 * 能力 ID 在源码中的两种访问形态：
 * - 索引访问：`["game.world"]`，包括 `x?.["game.world"]` 与跨行写法；
 * - 声明解构：`const { "game.world": world } = context.modules`。
 * 扫描器跳过注释与普通字符串，避免把注释文字或频道名等对象键误判为能力使用；
 * 浏览器 realm 通过 client-sdk 的 `usePort` 取端口，不走索引访问，因此只对 server 模块做源码对账。
 */
const capabilityGroups: ReadonlySet<string> = new Set([
  "game",
  "platform",
  "client",
  "console",
  "agent",
  "transport",
]);

/** 判断字符串是否为契约能力 ID：`<group>.<family>`，family 只含小写字母、数字与连字符。 */
function isCapabilityId(value: string): boolean {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator !== value.lastIndexOf(".")) {
    return false;
  }
  if (!capabilityGroups.has(value.slice(0, separator))) {
    return false;
  }
  const family = value.slice(separator + 1);
  if (family.length === 0) {
    return false;
  }
  for (const character of family) {
    const isLowercase = character >= "a" && character <= "z";
    const isDigit = character >= "0" && character <= "9";
    if (!isLowercase && !isDigit && character !== "-") {
      return false;
    }
  }
  return true;
}

const whitespaceCharacters: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"]);

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && whitespaceCharacters.has(character);
}

function isIdentifierCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const isLowercase = character >= "a" && character <= "z";
  const isUppercase = character >= "A" && character <= "Z";
  const isDigit = character >= "0" && character <= "9";
  return isLowercase || isUppercase || isDigit || character === "_" || character === "$";
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index += 1) {
    if (text[index] === "\n") {
      count += 1;
    }
  }
  return count;
}

/** 读取从 quoteIndex 开始的引号字符串；不是合法能力 ID 时返回 null。 */
function readCapabilityString(
  text: string,
  quoteIndex: number,
): { readonly capability: string; readonly end: number } | null {
  const quote = text[quoteIndex];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let end = quoteIndex + 1;
  let value = "";
  while (end < text.length) {
    const current = text[end];
    if (current === "\\") {
      return null;
    }
    if (current === quote) {
      break;
    }
    value += current;
    end += 1;
  }
  if (end >= text.length || !isCapabilityId(value)) {
    return null;
  }
  return { capability: value, end: end + 1 };
}

/** 跳过空白字符，返回下一个有效位置与经过的换行数。 */
function skipTrivia(
  text: string,
  from: number,
): { readonly index: number; readonly newlines: number } {
  let index = from;
  let newlines = 0;
  while (index < text.length) {
    const current = text[index];
    if (current === "\n") {
      newlines += 1;
      index += 1;
      continue;
    }
    if (current === " " || current === "\t" || current === "\r") {
      index += 1;
      continue;
    }
    break;
  }
  return { index, newlines };
}

/** 跳过普通字符串或模板字符串，返回结束位置；用于避免把字符串内容当成代码。 */
function skipStringLiteral(text: string, from: number): number {
  const quote = text[from];
  let index = from + 1;
  while (index < text.length) {
    const current = text[index];
    if (current === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (current === quote) {
      break;
    }
  }
  return index;
}

/** 返回指定位置之前最近的标识符，用于识别 `const`/`let`/`var` 声明。 */
function previousWord(text: string, index: number): string {
  let end = index - 1;
  while (end >= 0 && isWhitespace(text[end])) {
    end -= 1;
  }
  let start = end;
  while (start >= 0 && isIdentifierCharacter(text[start])) {
    start -= 1;
  }
  return text.slice(start + 1, end + 1);
}

/** 解构声明只接受 `const`/`let`/`var` 之后的对象模式；普通对象字面量不计为能力访问。 */
const declarationKeywords: ReadonlySet<string> = new Set(["const", "let", "var"]);

/**
 * 扫描一个对象解构模式里作为键的能力 ID。
 * 只在模式第 1 层识别字符串键，嵌套默认值里的表达式由主扫描继续处理。
 */
function destructuringKeys(
  text: string,
  braceIndex: number,
): readonly { readonly capability: string; readonly newlines: number }[] {
  const hits: { capability: string; newlines: number }[] = [];
  let depth = 0;
  let newlines = 0;
  let index = braceIndex;
  while (index < text.length) {
    const current = text[index];
    if (current === "\n") {
      newlines += 1;
      index += 1;
      continue;
    }
    if (current === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index + 2);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (current === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const endIndex = end === -1 ? text.length : end + 2;
      newlines += countNewlines(text, index, endIndex);
      index = endIndex;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      if (depth === 1) {
        const literal = readCapabilityString(text, index);
        if (literal !== null) {
          const after = skipTrivia(text, literal.end);
          if (text[after.index] === ":") {
            hits.push({ capability: literal.capability, newlines });
          }
        }
      }
      index = skipStringLiteral(text, index);
      continue;
    }
    if (current === "{") {
      depth += 1;
    } else if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return hits;
      }
    }
    index += 1;
  }
  return hits;
}

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
  return found.sort((left, right) => left.localeCompare(right));
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

/** 抽取一个源码文件中按能力 ID 访问端口的行与能力名；跳过注释与普通字符串。 */
function capabilityAccesses(file: string): readonly { readonly capability: string; readonly line: number }[] {
  const text = readFileSync(file, "utf8");
  const accesses: { capability: string; line: number }[] = [];
  let line = 1;
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    if (current === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (current === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index + 2);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (current === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const endIndex = end === -1 ? text.length : end + 2;
      line += countNewlines(text, index, endIndex);
      index = endIndex;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      const end = skipStringLiteral(text, index);
      line += countNewlines(text, index, end);
      index = end;
      continue;
    }
    if (current === "{") {
      if (declarationKeywords.has(previousWord(text, index))) {
        for (const key of destructuringKeys(text, index)) {
          accesses.push({ capability: key.capability, line: line + key.newlines });
        }
      }
      index += 1;
      continue;
    }
    if (current === "[") {
      const inner = skipTrivia(text, index + 1);
      const literal = readCapabilityString(text, inner.index);
      if (literal !== null) {
        const after = skipTrivia(text, literal.end);
        const receiver = previousSignificantChar(text, index);
        const isIndexAccess =
          text[after.index] === "]" &&
          (isIdentifierCharacter(receiver) || receiver === ")" || receiver === "]" || receiver === "?");
        if (isIndexAccess) {
          accesses.push({ capability: literal.capability, line: line + inner.newlines });
          line += inner.newlines + after.newlines;
          index = after.index + 1;
          continue;
        }
      }
    }
    index += 1;
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
