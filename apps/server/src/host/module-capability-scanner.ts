/**
 * 核心职责：词法扫描单个模块源码（三个 realm 通用），找出按能力 ID 或宿主固定端口键取用端口的位置与行号，
 * 以及以非字面量键取用端口、因而无法静态得知能力 ID 的位置。
 * 交互契约：输入为源码文本，返回端口访问记录；能力 ID 与宿主固定端口键的语法只取自公共契约，
 * 词法原语取自 module-source-lexer，不读文件、不判定访问是否已声明，对账与违规汇总由调用方负责。
 * 约束与禁忌：只做词法扫描，不执行源码；注释与普通字符串里的能力名不算访问。
 * 端口容器按名字识别，把容器转存到其他名字后再索引、或经 Object.values 等反射式枚举读取不在识别范围。
 */
import { CAPABILITY_GROUPS, CAPABILITY_ID_PATTERN, HOST_PORT_PATTERN } from "@world-prism/contracts";
import {
  countNewlines,
  identifierEndingAt,
  isIdentifierCharacter,
  matchingOpenParenthesis,
  previousSignificantChar,
  previousSignificantIndex,
  previousWord,
  skipStringLiteral,
  skipTrivia,
} from "./module-source-lexer";

/**
 * 端口键在源码中的三种取用形态：
 * - 索引访问：`["game.world"]`，包括 `x?.["game.world"]` 与跨行写法；
 * - 声明解构：`const { "game.world": world } = context.modules`；
 * - 浏览器 hook 调用：`usePort("client.camera")`、`usePortSubscription<T>("client.world-view")`。
 * 端口键是能力 ID，或浏览器宿主固定端口键 `host.<name>`（如 `ports["host.api"]`、`usePort("host.console")`）。
 * 扫描器跳过注释与普通字符串，避免把注释文字或频道名等对象键误判为能力使用；
 * 两种键的语法只由公共契约提供，扫描与描述符校验共用同一判定。
 */
export function isPortKey(value: string): boolean {
  return CAPABILITY_ID_PATTERN.test(value) || HOST_PORT_PATTERN.test(value);
}

/**
 * 判断字符串是否「明显在写端口键」：以能力 group 或 `host` 开头并跟一个分隔点。
 * 这类字符串出现在端口取用位置却不合语法，说明作者写错了键，
 * 必须显式报违规而不是静默跳过，否则描述符与扫描器会再次分叉。
 */
function looksLikePortKey(value: string): boolean {
  const separator = value.indexOf(".");
  if (separator <= 0) {
    return false;
  }
  const group = value.slice(0, separator);
  // eslint-disable-next-line no-restricted-syntax -- 白名单是契约导出的只读字面量数组。
  return group === "host" || CAPABILITY_GROUPS.includes(group as (typeof CAPABILITY_GROUPS)[number]);
}

/**
 * 一条源码端口访问：
 * - `literal`：写死端口键的访问；语法合法的进入对账集合，语法非法但明显是端口键的单独报告；
 * - `dynamic-key`：以非字面量键取用端口，无法静态得知访问了哪个能力，`receiver` 为端口容器名或 hook 名。
 */
export type CapabilityAccess =
  | { readonly kind: "literal"; readonly value: string; readonly line: number; readonly valid: boolean }
  | { readonly kind: "dynamic-key"; readonly receiver: string; readonly line: number };

/**
 * 端口容器按名字识别：宿主注入的 `ports`、规则上下文的 `modules`，
 * 以及以 `Ports` 结尾的变量、属性、类型或返回端口视图的调用（如 `asPorts(context)`）。
 */
const PORT_CONTAINER_NAME = /^(?:ports|modules)$|Ports$/;

/**
 * 读取从 quoteIndex 开始、不含转义的单引号或双引号字符串，返回内容与闭合引号之后的位置。
 * 带转义、未闭合或不是引号起始时返回 null：这类键无法与声明静态对账。
 */
function readQuotedString(text: string, quoteIndex: number): { readonly value: string; readonly end: number } | null {
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
      return { value, end: end + 1 };
    }
    value += current;
    end += 1;
  }
  return null;
}

/**
 * 读取从 quoteIndex 开始的引号字符串。
 * 语法合法的端口键返回 `valid: true`；明显在写端口键但语法非法时返回 `valid: false`，
 * 由调用方报告；其余普通字符串返回 null，不参与对账。
 */
function readCapabilityString(
  text: string,
  quoteIndex: number,
): { readonly capability: string; readonly end: number; readonly valid: boolean } | null {
  const literal = readQuotedString(text, quoteIndex);
  if (literal === null) {
    return null;
  }
  if (isPortKey(literal.value)) {
    return { capability: literal.value, end: literal.end, valid: true };
  }
  if (looksLikePortKey(literal.value)) {
    return { capability: literal.value, end: literal.end, valid: false };
  }
  return null;
}

/** 浏览器模块经 client-sdk 取端口的 hook 名；首个实参就是端口键。 */
const PORT_HOOK_NAMES: ReadonlySet<string> = new Set(["usePort", "usePortSubscription"]);

/**
 * 读取 hook 名之后的调用：跳过可选的类型实参 `<...>`（箭头 `=>` 中的 `>` 不算闭合），
 * 返回首个实参的起点与经过的换行数。名字后面不是调用（如 import 列表中的名字）时返回 null。
 */
function hookArgument(text: string, nameEnd: number): { readonly index: number; readonly newlines: number } | null {
  let { index, newlines } = skipTrivia(text, nameEnd);
  if (text[index] === "<") {
    let depth = 0;
    while (index < text.length) {
      const current = text[index];
      if (current === "\n") {
        newlines += 1;
      } else if (current === "<") {
        depth += 1;
      } else if (current === ">" && text[index - 1] !== "=") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
      index += 1;
    }
    const afterTypeArguments = skipTrivia(text, index);
    index = afterTypeArguments.index;
    newlines += afterTypeArguments.newlines;
  }
  if (text[index] !== "(") {
    return null;
  }
  const argument = skipTrivia(text, index + 1);
  return { index: argument.index, newlines: newlines + argument.newlines };
}

/** 解构声明只接受 `const`/`let`/`var` 之后的对象模式；普通对象字面量不计为能力访问。 */
const declarationKeywords: ReadonlySet<string> = new Set(["const", "let", "var"]);

/** 一个对象解构模式的扫描结果。 */
interface DestructuringPattern {
  readonly keys: readonly { readonly capability: string; readonly newlines: number; readonly valid: boolean }[];
  /** 第 1 层计算键 `{ [expr]: x }` 相对模式起点的换行数；没有计算键时为 null。 */
  readonly computedKeyNewlines: number | null;
  /** 闭合 `}` 之后的位置，用于读取被解构的来源；模式未闭合时为文本末尾。 */
  readonly end: number;
}

/**
 * 扫描一个对象解构模式里作为键的能力 ID，并记录第 1 层是否出现计算键。
 * 只在模式第 1 层识别键，嵌套默认值里的表达式由主扫描继续处理。
 * 语法非法但明显在写能力 ID 的键同样收集，由上层报告为语法违规。
 */
function destructuringPattern(text: string, braceIndex: number): DestructuringPattern {
  const hits: { capability: string; newlines: number; valid: boolean }[] = [];
  let computedKeyNewlines: number | null = null;
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
    // 第 1 层紧跟 `{` 或 `,` 的方括号是计算键；跟在 `=` 或 `:` 后的是默认值或嵌套数组模式。
    if (current === "[" && depth === 1 && computedKeyNewlines === null) {
      const before = previousSignificantChar(text, index);
      if (before === "{" || before === ",") {
        computedKeyNewlines = newlines;
      }
    }
    if (current === "{") {
      depth += 1;
    } else if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return { keys: hits, computedKeyNewlines, end: index + 1 };
      }
    }
    index += 1;
  }
  return { keys: hits, computedKeyNewlines, end: text.length };
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

/**
 * 取索引访问 `[` 之前接收者的末端名字：`a.ports[k]`、`ports?.[k]` 取 `ports`；
 * 调用 `asPorts(context)[k]` 取被调函数名；括号表达式 `(x as GameModulePorts)[k]` 取括号内最后的名字。
 */
function indexReceiverName(text: string, bracketIndex: number): string {
  let cursor = previousSignificantIndex(text, bracketIndex);
  if (text[cursor] === ".") {
    cursor = previousSignificantIndex(text, cursor);
    if (text[cursor] === "?") {
      cursor = previousSignificantIndex(text, cursor);
    }
  }
  if (text[cursor] !== ")") {
    return identifierEndingAt(text, cursor);
  }
  const open = matchingOpenParenthesis(text, cursor);
  const callee = open < 0 ? "" : identifierEndingAt(text, previousSignificantIndex(text, open));
  return callee !== "" ? callee : identifierEndingAt(text, previousSignificantIndex(text, cursor));
}

/** 键是否为不含转义的单引号或双引号字面量，且紧跟闭合的 `]`。 */
function isPlainStringKey(text: string, keyIndex: number): boolean {
  const quote = text[keyIndex];
  if (quote !== '"' && quote !== "'") {
    return false;
  }
  let cursor = keyIndex + 1;
  while (cursor < text.length && text[cursor] !== quote) {
    if (text[cursor] === "\\" || text[cursor] === "\n") {
      return false;
    }
    cursor += 1;
  }
  return cursor < text.length && text[skipTrivia(text, cursor + 1).index] === "]";
}

/**
 * 读取 `} = <来源>` 中被解构来源的末端名字：成员链（`a.b`、`a?.b`，点号两侧允许空白）取最后一段，调用取被调函数名。
 * 逐字符读取成员链，不用带回溯的正则，耗时与成员链长度成线性。
 */
function assignedSourceName(text: string, patternEnd: number): string {
  const assignment = skipTrivia(text, patternEnd);
  if (text[assignment.index] !== "=") {
    return "";
  }
  let cursor = skipTrivia(text, assignment.index + 1).index;
  let last = "";
  for (;;) {
    const start = cursor;
    while (isIdentifierCharacter(text[cursor])) {
      cursor += 1;
    }
    if (cursor === start) {
      return last;
    }
    last = text.slice(start, cursor);
    let next = skipTrivia(text, cursor).index;
    if (text[next] === "?") {
      next += 1;
    }
    if (text[next] !== ".") {
      return last;
    }
    cursor = skipTrivia(text, next + 1).index;
  }
}

/**
 * 抽取一个源码文件中按能力 ID 访问端口的行与能力名，以及以非字面量键读取端口容器的位置；
 * 跳过注释与普通字符串。
 */
export function capabilityAccesses(text: string): readonly CapabilityAccess[] {
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
    if (isIdentifierCharacter(current) && !isIdentifierCharacter(text[index - 1])) {
      let wordEnd = index;
      while (isIdentifierCharacter(text[wordEnd])) {
        wordEnd += 1;
      }
      const hookName = text.slice(index, wordEnd);
      const argument = PORT_HOOK_NAMES.has(hookName) ? hookArgument(text, wordEnd) : null;
      if (argument === null) {
        index = wordEnd;
        continue;
      }
      // hook 的首个实参只能是写死的端口键：任何字符串都按端口键判定语法，非字符串实参无法静态对账。
      // 字符串之后必须紧跟实参结束（`)` 或 `,`）：`"client.camera" + suffix` 这类表达式运行时取的是拼接结果，
      // 若只看开头的字面量就会把动态键当成静态访问，绕过对账。
      line += argument.newlines;
      const literal = readQuotedString(text, argument.index);
      const afterLiteral = literal === null ? null : skipTrivia(text, literal.end);
      if (literal === null || afterLiteral === null || (text[afterLiteral.index] !== ")" && text[afterLiteral.index] !== ",")) {
        accesses.push({ kind: "dynamic-key", receiver: hookName, line });
        index = argument.index;
        continue;
      }
      accesses.push({ kind: "literal", value: literal.value, line, valid: isPortKey(literal.value) });
      index = literal.end;
      continue;
    }
    if (current === "{") {
      if (declarationKeywords.has(previousWord(text, index))) {
        const pattern = destructuringPattern(text, index);
        for (const key of pattern.keys) {
          accesses.push({ kind: "literal", value: key.capability, line: line + key.newlines, valid: key.valid });
        }
        const source = pattern.computedKeyNewlines === null ? "" : assignedSourceName(text, pattern.end);
        if (pattern.computedKeyNewlines !== null && PORT_CONTAINER_NAME.test(source)) {
          accesses.push({ kind: "dynamic-key", receiver: source, line: line + pattern.computedKeyNewlines });
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
          accesses.push({ kind: "literal", value: literal.capability, line: line + inner.newlines, valid: literal.valid });
          line += inner.newlines + after.newlines;
          index = after.index + 1;
          continue;
        }
      }
      // 端口容器只接受写死的引号字面量键；变量、模板字符串与带转义的字面量都无法与 requires 静态对账。
      // 空方括号是数组类型（如 `GamePorts[]`），不是索引访问。
      const isEmptyBrackets = text[inner.index] === "]";
      if (!isEmptyBrackets && isMemberAccessReceiver(text, index) && !isPlainStringKey(text, inner.index)) {
        const receiver = indexReceiverName(text, index);
        if (PORT_CONTAINER_NAME.test(receiver)) {
          accesses.push({ kind: "dynamic-key", receiver, line });
        }
      }
    }
    index += 1;
  }
  return accesses;
}
