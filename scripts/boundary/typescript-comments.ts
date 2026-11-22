/**
 * 核心职责：扫描 TypeScript、JavaScript 与 JSX 源码中的真实注释区间。
 * 交互契约：输入完整源码文本，输出按出现顺序排列的注释原文与起始下标。
 * 约束与禁忌：不执行被检查代码、不构建语义树，也不把字符串、正则或模板正文当成注释。
 */
/* eslint-disable security/detect-object-injection -- 索引只来自源码字符位置或固定栈末尾，不来自外部对象键。 */
import type { CommentSpan } from "./types";

type Mode = "code" | "line" | "block" | "single" | "double" | "template" | "regex" | "jsxText";

const EXPRESSION_START_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const CONTROL_HEADER_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);

function isWhitespace(character: string): boolean {
  return character !== "" && character.trim() === "";
}

function previousNonWhitespace(source: string, index: number): string {
  let previous = index - 1;
  while (previous >= 0 && isWhitespace(source.charAt(previous))) {
    previous -= 1;
  }
  return source.charAt(previous);
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

function isIdentifierStart(character: string): boolean {
  return (
    (character >= "A" && character <= "Z") ||
    (character >= "a" && character <= "z") ||
    character === "_" ||
    character === "$"
  );
}

function isIdentifierPart(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character);
}

function isExpressionPrefixOperator(character: string): boolean {
  return "([{,;:?=!&|+-*%^~<>".includes(character);
}

function isExpressionSuffix(character: string): boolean {
  return character === ")" || character === "]" || character === "}";
}

/** 只把能开启表达式的 `/` 视为正则，避免后缀自增后的除法吞掉尾随注释。 */
export function collectTypeScriptCommentSpans(source: string, jsx = false): CommentSpan[] {
  const spans: CommentSpan[] = [];
  const templateExpressionDepths: number[] = [];
  const jsxExpressionDepths: number[] = [];
  const parenthesisContexts: (string | null)[] = [];
  let mode: Mode = "code";
  let start = 0;
  let expectExpression = true;
  let index = 0;
  let inRegexCharacterClass = false;
  let pendingControlKeyword: string | null = null;
  let jsxTextDepth = 0;
  let jsxTag: "opening" | "closing" | null = null;
  let jsxTagBraceDepth = 0;

  while (index < source.length) {
    const character = source.charAt(index);
    const next = source.charAt(index + 1);

    if (mode === "line") {
      if (character === "\n") {
        spans.push({ text: source.slice(start, index), start });
        mode = "code";
      }
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (character === "*" && next === "/") {
        spans.push({ text: source.slice(start, index + 2), start });
        mode = "code";
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (mode === "single" || mode === "double") {
      if (character === "\\") {
        index += 2;
      } else if ((mode === "single" && character === "'") || (mode === "double" && character === '"')) {
        mode = "code";
        expectExpression = false;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (mode === "regex") {
      if (character === "\\") {
        index += 2;
      } else if (character === "[") {
        inRegexCharacterClass = true;
        index += 1;
      } else if (character === "]") {
        inRegexCharacterClass = false;
        index += 1;
      } else if (character === "/" && !inRegexCharacterClass) {
        mode = "code";
        expectExpression = false;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (mode === "template") {
      if (character === "\\") {
        index += 2;
      } else if (character === "`") {
        mode = "code";
        expectExpression = false;
        index += 1;
      } else if (character === "$" && next === "{") {
        templateExpressionDepths.push(0);
        mode = "code";
        expectExpression = true;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (mode === "jsxText") {
      if (character === "<") {
        mode = "code";
        expectExpression = true;
        continue;
      }
      if (character === "{") {
        jsxExpressionDepths.push(0);
        mode = "code";
        expectExpression = true;
      }
      index += 1;
      continue;
    }

    if (isWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      start = index;
      mode = "line";
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      start = index;
      mode = "block";
      index += 2;
      continue;
    }
    if (jsx && jsxTag === null && character === "<" && expectExpression) {
      if (next === "/") {
        jsxTag = "closing";
        index += 2;
        continue;
      }
      if (next === ">" || isIdentifierStart(next)) {
        jsxTag = "opening";
        index += 1;
        continue;
      }
    }
    if (jsxTag !== null && character === "{") {
      jsxTagBraceDepth += 1;
      expectExpression = true;
      index += 1;
      continue;
    }
    if (jsxTag !== null && character === "}" && jsxTagBraceDepth > 0) {
      jsxTagBraceDepth -= 1;
      expectExpression = false;
      index += 1;
      continue;
    }
    if (jsxTag !== null && character === ">" && jsxTagBraceDepth === 0) {
      const selfClosing = previousNonWhitespace(source, index) === "/";
      if (jsxTag === "closing") {
        jsxTextDepth = Math.max(0, jsxTextDepth - 1);
      } else if (!selfClosing) {
        jsxTextDepth += 1;
      }
      jsxTag = null;
      mode = jsxTextDepth > 0 ? "jsxText" : "code";
      expectExpression = false;
      index += 1;
      continue;
    }
    if (character !== "(" && !isIdentifierStart(character)) {
      pendingControlKeyword = null;
    }
    if (character === "'") {
      mode = "single";
      index += 1;
      continue;
    }
    if (character === '"') {
      mode = "double";
      index += 1;
      continue;
    }
    if (character === "`") {
      mode = "template";
      index += 1;
      continue;
    }
    if (character === "/") {
      if (jsxTag !== null && jsxTagBraceDepth === 0) {
        expectExpression = true;
        index += 1;
        continue;
      }
      const previous = source[index - 1] ?? "";
      if (expectExpression && previous !== "<") {
        mode = "regex";
      } else {
        expectExpression = true;
      }
      index += 1;
      continue;
    }
    if (character === "}" && templateExpressionDepths.length > 0) {
      const depthIndex = templateExpressionDepths.length - 1;
      const depth = templateExpressionDepths[depthIndex] ?? 0;
      if (depth === 0) {
        templateExpressionDepths.pop();
        mode = "template";
      } else {
        templateExpressionDepths[depthIndex] = depth - 1;
        expectExpression = false;
      }
      index += 1;
      continue;
    }
    if (character === "}" && jsxExpressionDepths.length > 0) {
      const depthIndex = jsxExpressionDepths.length - 1;
      const depth = jsxExpressionDepths[depthIndex] ?? 0;
      if (depth === 0) {
        jsxExpressionDepths.pop();
        mode = "jsxText";
      } else {
        jsxExpressionDepths[depthIndex] = depth - 1;
        expectExpression = false;
      }
      index += 1;
      continue;
    }
    if (character === "{") {
      if (templateExpressionDepths.length > 0) {
        const depthIndex = templateExpressionDepths.length - 1;
        templateExpressionDepths[depthIndex] = (templateExpressionDepths[depthIndex] ?? 0) + 1;
      }
      if (jsxExpressionDepths.length > 0) {
        const depthIndex = jsxExpressionDepths.length - 1;
        jsxExpressionDepths[depthIndex] = (jsxExpressionDepths[depthIndex] ?? 0) + 1;
      }
      expectExpression = true;
      index += 1;
      continue;
    }
    if (character === "(") {
      parenthesisContexts.push(pendingControlKeyword);
      pendingControlKeyword = null;
      expectExpression = true;
      index += 1;
      continue;
    }
    if (character === ")") {
      const controlHeader = parenthesisContexts.pop() ?? null;
      pendingControlKeyword = null;
      expectExpression = controlHeader !== null;
      index += 1;
      continue;
    }
    if (isDigit(character)) {
      expectExpression = false;
      index += 1;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (isIdentifierPart(source.charAt(end))) {
        end += 1;
      }
      const word = source.slice(index, end);
      if (word === "of" && parenthesisContexts.at(-1) === "for") {
        expectExpression = true;
      } else {
        expectExpression = EXPRESSION_START_KEYWORDS.has(word);
      }
      pendingControlKeyword = CONTROL_HEADER_KEYWORDS.has(word) ? word : null;
      index = end;
      continue;
    }
    if ((character === "+" || character === "-") && next === character) {
      index += 2;
      continue;
    }
    if (isExpressionSuffix(character)) {
      expectExpression = false;
      index += 1;
      continue;
    }
    if (isExpressionPrefixOperator(character)) {
      expectExpression = true;
    }
    index += 1;
  }

  if (mode === "line" || mode === "block") {
    spans.push({ text: source.slice(start), start });
  }
  return spans;
}
