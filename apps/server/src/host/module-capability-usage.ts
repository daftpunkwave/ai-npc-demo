/**
 * 核心职责：静态对账模块描述符的 provides/requires 与模块源码实际访问的能力端口。
 * 交互契约：只读取仓库 modules 目录下的手写源码与已登记模块定义，不执行模块代码、不访问存储；
 * 对账结果交给目录预检汇总，供 `pnpm check:catalog` 在启动前发现漏声明、多余声明与拼写错误。
 * 约束与禁忌：不按模块 ID 猜测实现、不跳过读不到源码的模块，也不把能力访问限制成运行期才暴露的问题；
 * 只识别源码中写死能力 ID 的索引访问与对象键，动态键（如 `ports[variable]`）属于无法静态求值的形式，不在此检查。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CAPABILITY_GROUPS, CAPABILITY_ID_PATTERN, type ModuleDefinition } from "@ai-npc/contracts";
import { findModuleDirectories, moduleIdentifier, sourceFilesOf, type ModuleSource } from "./module-sources";


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
 * 能力 ID 的语法只由公共契约提供，扫描与描述符校验共用同一判定。
 */
function isCapabilityId(value: string): boolean {
  return CAPABILITY_ID_PATTERN.test(value);
}

/**
 * 判断字符串是否「明显在写能力 ID」：以能力 group 开头并跟一个分隔点。
 * 这类字符串出现在能力取用位置却不是合法能力 ID，说明作者写错了语法，
 * 必须显式报违规而不是静默跳过，否则描述符与扫描器会再次分叉。
 */
function looksLikeCapabilityId(value: string): boolean {
  const separator = value.indexOf(".");
  if (separator <= 0) {
    return false;
  }
  // eslint-disable-next-line no-restricted-syntax -- 白名单是契约导出的只读字面量数组。
  return CAPABILITY_GROUPS.includes(value.slice(0, separator) as (typeof CAPABILITY_GROUPS)[number]);
}

/** 一条源码能力访问：语法合法的进入对账集合，语法非法但明显是能力 ID 的单独报告。 */
interface CapabilityAccess {
  readonly value: string;
  readonly line: number;
  readonly valid: boolean;
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

/**
 * 读取从 quoteIndex 开始的引号字符串。
 * 语法合法的能力 ID 返回 `valid: true`；明显在写能力 ID 但语法非法时返回 `valid: false`，
 * 由调用方报告；其余普通字符串返回 null，不参与对账。
 */
function readCapabilityString(
  text: string,
  quoteIndex: number,
): { readonly capability: string; readonly end: number; readonly valid: boolean } | null {
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
  if (end >= text.length) {
    return null;
  }
  if (isCapabilityId(value)) {
    return { capability: value, end: end + 1, valid: true };
  }
  if (looksLikeCapabilityId(value)) {
    return { capability: value, end: end + 1, valid: false };
  }
  return null;
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
 * 语法非法但明显在写能力 ID 的键同样收集，由上层报告为语法违规。
 */
function destructuringKeys(
  text: string,
  braceIndex: number,
): readonly { readonly capability: string; readonly newlines: number; readonly valid: boolean }[] {
  const hits: { capability: string; newlines: number; valid: boolean }[] = [];
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
            hits.push({ capability: literal.capability, newlines, valid: literal.valid });
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

/** 抽取一个源码文件中按能力 ID 访问端口的行与能力名；跳过注释与普通字符串。 */
/** 返回指定位置之前最近的代码字符，用于区分索引访问与声明数组。 */
function previousSignificantChar(text: string, index: number): string {
  const at = previousSignificantIndex(text, index);
  return at < 0 ? "" : (text[at] ?? "");
}

/** 返回指定位置之前最近的非空白字符位置；没有时返回 -1。 */
function previousSignificantIndex(text: string, index: number): number {
  let cursor = index - 1;
  while (cursor >= 0 && isWhitespace(text[cursor])) {
    cursor -= 1;
  }
  return cursor;
}

/**
 * 判断 `[` 之前的接收者是否是成员访问链的终点。
 *
 * 除标识符、`)` 与 `]` 外，`ports?.["x"]` 的 `[` 前一个有效字符是 `.`。
 * 漏判会让同一处能力访问在改写为可选链后静默逃过对账，正是本检查要防的情况。
 *
 * 但 `.` 有三种来源，不能一律当成成员访问：
 * - `?.`：可选链，是成员访问；
 * - `obj.`：普通属性访问，是成员访问；
 * - `...`：展开运算符，`[...["a"]]` 里的 `["a"]` 是数组字面量而不是能力取用。
 * 把展开误判为访问会让装配检查错误地拒绝合法模块，因此必须按 `.` 之前的字符区分。
 */
function isMemberAccessReceiver(text: string, bracketIndex: number): boolean {
  const dotIndex = previousSignificantIndex(text, bracketIndex);
  const receiver = dotIndex < 0 ? "" : (text[dotIndex] ?? "");
  if (isIdentifierCharacter(receiver) || receiver === ")" || receiver === "]") {
    return true;
  }
  if (receiver !== ".") {
    return false;
  }
  // `...` 是展开运算符：`.` 之前仍是 `.`，说明这个方括号属于被展开的数组字面量。
  return previousSignificantChar(text, dotIndex) !== ".";
}

function capabilityAccesses(file: string): readonly CapabilityAccess[] {
  const text = readFileSync(file, "utf8");
  const accesses: CapabilityAccess[] = [];
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
          accesses.push({ value: key.capability, line: line + key.newlines, valid: key.valid });
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
        // 只有「成员取用」后的索引才是能力访问：`ports["x"]`、`ports?.["x"]`、`f()["x"]`。
        // 声明数组与计算属性名的错位写法不在此列，但仍按成员访问判定即可——
        // 接收者不是表达式时这些形态本就无法编译。
        const isIndexAccess = text[after.index] === "]" && isMemberAccessReceiver(text, index);
        if (isIndexAccess) {
          accesses.push({ value: literal.capability, line: line + inner.newlines, valid: literal.valid });
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
      for (const access of capabilityAccesses(file)) {
        const relativeFile = displayPath(root, file);
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
