/**
 * 核心职责：扫描 TypeScript、JavaScript 与 JSX 源码中的真实注释区间。
 * 交互契约：输入完整源码文本，输出按出现顺序排列的注释原文与起始下标。
 * 约束与禁忌：不执行被检查代码、不构建语义树，也不把字符串、正则或模板正文当成注释。
 */
/* eslint-disable security/detect-object-injection -- 索引只来自源码字符位置或固定栈末尾，不来自外部对象键。 */
import type { CommentSpan } from "./types";

type Mode = "code" | "line" | "block" | "single" | "double" | "template" | "regex";

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
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function isWhitespace(character: string): boolean {
  return character !== "" && character.trim() === "";
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
export function collectTypeScriptCommentSpans(source: string): CommentSpan[] {
  const spans: CommentSpan[] = [];
  const templateExpressionDepths: number[] = [];
  let mode: Mode = "code";
  let start = 0;
  let expectExpression = true;
  let index = 0;

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
      } else if (character === "/") {
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
    if (character === "{") {
      if (templateExpressionDepths.length > 0) {
        const depthIndex = templateExpressionDepths.length - 1;
        templateExpressionDepths[depthIndex] = (templateExpressionDepths[depthIndex] ?? 0) + 1;
      }
      expectExpression = true;
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
      expectExpression = EXPRESSION_START_KEYWORDS.has(word);
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
