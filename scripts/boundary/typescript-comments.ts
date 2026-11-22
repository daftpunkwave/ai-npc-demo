/**
 * 核心职责：扫描 TypeScript、JavaScript 与 JSX 源码中的真实注释区间。
 * 交互契约：输入完整源码文本，输出按出现顺序排列的注释原文与起始下标。
 * 约束与禁忌：不执行被检查代码、不构建语义树，也不把字符串、正则或模板正文当成注释。
 */
/* eslint-disable security/detect-object-injection -- 索引只来自源码字符位置或固定栈末尾，不来自外部对象键。 */
import type { CommentSpan } from "./types";

type Mode = "code" | "line" | "block" | "single" | "double" | "template" | "regex" | "jsxText";
type JsxTagKind = "opening" | "closing";

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
  return character === "]" || character === "}";
}

/** 以显式词法状态扫描注释，不执行源码，也不把 JSX 文本或正则字符类当作代码。 */
class TypeScriptCommentScanner {
  private readonly spans: CommentSpan[] = [];
  private readonly templateExpressionDepths: number[] = [];
  private readonly jsxExpressionDepths: number[] = [];
  private readonly parenthesisContexts: (string | null)[] = [];
  private mode: Mode = "code";
  private start = 0;
  private expectExpression = true;
  private index = 0;
  private inRegexCharacterClass = false;
  private pendingControlKeyword: string | null = null;
  private jsxTextDepth = 0;
  private jsxTag: JsxTagKind | null = null;
  private jsxTagBraceDepth = 0;

  constructor(
    private readonly source: string,
    private readonly jsx: boolean,
  ) {}

  collect(): CommentSpan[] {
    while (this.index < this.source.length) {
      this.scanCurrentMode();
    }
    if (this.mode === "line" || this.mode === "block") {
      this.spans.push({ text: this.source.slice(this.start), start: this.start });
    }
    return this.spans;
  }

  private character(offset = 0): string {
    return this.source.charAt(this.index + offset);
  }

  private scanCurrentMode(): void {
    if (this.mode === "line") this.scanLine();
    else if (this.mode === "block") this.scanBlock();
    else if (this.mode === "single" || this.mode === "double") this.scanQuoted();
    else if (this.mode === "regex") this.scanRegex();
    else if (this.mode === "template") this.scanTemplate();
    else if (this.mode === "jsxText") this.scanJsxText();
    else this.scanCode();
  }

  private scanLine(): void {
    if (this.character() === "\n") {
      this.spans.push({ text: this.source.slice(this.start, this.index), start: this.start });
      this.mode = "code";
    }
    this.index += 1;
  }

  private scanBlock(): void {
    if (this.character() === "*" && this.character(1) === "/") {
      this.spans.push({ text: this.source.slice(this.start, this.index + 2), start: this.start });
      this.mode = "code";
      this.index += 2;
    } else {
      this.index += 1;
    }
  }

  private scanQuoted(): void {
    const character = this.character();
    if (character === "\\") {
      this.index += 2;
      return;
    }
    if ((this.mode === "single" && character === "'") || (this.mode === "double" && character === '"')) {
      this.mode = "code";
      this.expectExpression = false;
    }
    this.index += 1;
  }

  private scanRegex(): void {
    const character = this.character();
    if (character === "\\") {
      this.index += 2;
      return;
    }
    if (character === "[") this.inRegexCharacterClass = true;
    else if (character === "]") this.inRegexCharacterClass = false;
    else if (character === "/" && !this.inRegexCharacterClass) {
      this.mode = "code";
      this.expectExpression = false;
    }
    this.index += 1;
  }

  private scanTemplate(): void {
    const character = this.character();
    if (character === "\\") {
      this.index += 2;
      return;
    }
    if (character === "`") {
      this.mode = "code";
      this.expectExpression = false;
    } else if (character === "$" && this.character(1) === "{") {
      this.templateExpressionDepths.push(0);
      this.mode = "code";
      this.expectExpression = true;
      this.index += 2;
      return;
    }
    this.index += 1;
  }

  private scanJsxText(): void {
    const character = this.character();
    if (character === "<") {
      this.mode = "code";
      this.expectExpression = true;
      return;
    }
    if (character === "{") {
      this.jsxExpressionDepths.push(0);
      this.mode = "code";
      this.expectExpression = true;
    }
    this.index += 1;
  }

  private scanCode(): void {
    const character = this.character();
    if (isWhitespace(character)) {
      this.index += 1;
      return;
    }
    if (this.scanCommentStart()) return;
    if (this.scanJsx()) return;
    if (character !== "(" && !isIdentifierStart(character)) this.pendingControlKeyword = null;
    if (this.scanStringStart()) return;
    if (this.scanSlash()) return;
    if (this.scanTemplateExpressionClose()) return;
    if (this.scanJsxExpressionClose()) return;
    if (this.scanParenthesis()) return;
    if (this.scanOpenBrace()) return;
    if (isDigit(character)) {
      this.expectExpression = false;
      this.index += 1;
      return;
    }
    if (isIdentifierStart(character)) {
      this.scanIdentifier();
      return;
    }
    if ((character === "+" || character === "-") && this.character(1) === character) {
      this.index += 2;
      return;
    }
    if (isExpressionSuffix(character)) this.expectExpression = false;
    else if (isExpressionPrefixOperator(character)) this.expectExpression = true;
    this.index += 1;
  }

  private scanCommentStart(): boolean {
    if (this.character() !== "/") return false;
    const next = this.character(1);
    if (next !== "/" && next !== "*") return false;
    this.start = this.index;
    this.mode = next === "/" ? "line" : "block";
    this.index += 2;
    return true;
  }

  private scanJsx(): boolean {
    if (this.jsxTag !== null) return this.scanJsxTagContent();
    if (!this.jsx || this.character() !== "<" || !this.expectExpression) return false;
    const next = this.character(1);
    if (next === "/") {
      this.jsxTag = "closing";
      this.index += 2;
      return true;
    }
    if (next === ">" || isIdentifierStart(next)) {
      this.jsxTag = "opening";
      this.index += 1;
      return true;
    }
    return false;
  }

  private scanJsxTagContent(): boolean {
    const character = this.character();
    if (character === "{") {
      this.jsxTagBraceDepth += 1;
      this.expectExpression = true;
      this.index += 1;
      return true;
    }
    if (character === "}" && this.jsxTagBraceDepth > 0) {
      this.jsxTagBraceDepth -= 1;
      this.expectExpression = false;
      this.index += 1;
      return true;
    }
    if (character !== ">" || this.jsxTagBraceDepth > 0) return false;
    const selfClosing = previousNonWhitespace(this.source, this.index) === "/";
    if (this.jsxTag === "closing") this.jsxTextDepth = Math.max(0, this.jsxTextDepth - 1);
    else if (!selfClosing) this.jsxTextDepth += 1;
    this.jsxTag = null;
    this.mode = this.jsxTextDepth > 0 ? "jsxText" : "code";
    this.expectExpression = false;
    this.index += 1;
    return true;
  }

  private scanStringStart(): boolean {
    const character = this.character();
    if (character === "'") this.mode = "single";
    else if (character === '"') this.mode = "double";
    else if (character === "`") this.mode = "template";
    else return false;
    this.index += 1;
    return true;
  }

  private scanSlash(): boolean {
    if (this.character() !== "/") return false;
    if (this.jsxTag !== null && this.jsxTagBraceDepth === 0) {
      this.expectExpression = true;
      this.index += 1;
      return true;
    }
    if (this.expectExpression && this.source.charAt(this.index - 1) !== "<") {
      this.mode = "regex";
      this.inRegexCharacterClass = false;
    } else {
      this.expectExpression = true;
    }
    this.index += 1;
    return true;
  }

  private scanTemplateExpressionClose(): boolean {
    if (this.character() !== "}" || this.templateExpressionDepths.length === 0) return false;
    const depthIndex = this.templateExpressionDepths.length - 1;
    const depth = this.templateExpressionDepths[depthIndex] ?? 0;
    if (depth === 0) {
      this.templateExpressionDepths.pop();
      this.mode = "template";
    } else {
      this.templateExpressionDepths[depthIndex] = depth - 1;
      this.expectExpression = false;
    }
    this.index += 1;
    return true;
  }

  private scanJsxExpressionClose(): boolean {
    if (this.character() !== "}" || this.jsxExpressionDepths.length === 0) return false;
    const depthIndex = this.jsxExpressionDepths.length - 1;
    const depth = this.jsxExpressionDepths[depthIndex] ?? 0;
    if (depth === 0) {
      this.jsxExpressionDepths.pop();
      this.mode = "jsxText";
    } else {
      this.jsxExpressionDepths[depthIndex] = depth - 1;
      this.expectExpression = false;
    }
    this.index += 1;
    return true;
  }

  private scanParenthesis(): boolean {
    const character = this.character();
    if (character === "(") {
      this.parenthesisContexts.push(this.pendingControlKeyword);
      this.pendingControlKeyword = null;
      this.expectExpression = true;
    } else if (character === ")") {
      const controlHeader = this.parenthesisContexts.pop() ?? null;
      this.pendingControlKeyword = null;
      this.expectExpression = controlHeader !== null;
    } else {
      return false;
    }
    this.index += 1;
    return true;
  }

  private scanOpenBrace(): boolean {
    if (this.character() !== "{") return false;
    if (this.templateExpressionDepths.length > 0) {
      const depthIndex = this.templateExpressionDepths.length - 1;
      this.templateExpressionDepths[depthIndex] = (this.templateExpressionDepths[depthIndex] ?? 0) + 1;
    }
    if (this.jsxExpressionDepths.length > 0) {
      const depthIndex = this.jsxExpressionDepths.length - 1;
      this.jsxExpressionDepths[depthIndex] = (this.jsxExpressionDepths[depthIndex] ?? 0) + 1;
    }
    this.expectExpression = true;
    this.index += 1;
    return true;
  }

  private scanIdentifier(): void {
    let end = this.index + 1;
    while (isIdentifierPart(this.source.charAt(end))) {
      end += 1;
    }
    const word = this.source.slice(this.index, end);
    const wasExpectingExpression = this.expectExpression;
    this.expectExpression = word === "of" && this.parenthesisContexts.at(-1) === "for"
      ? true
      : EXPRESSION_START_KEYWORDS.has(word);
    this.pendingControlKeyword = wasExpectingExpression && CONTROL_HEADER_KEYWORDS.has(word) ? word : null;
    this.index = end;
  }
}

export function collectTypeScriptCommentSpans(source: string, jsx = false): CommentSpan[] {
  return new TypeScriptCommentScanner(source, jsx).collect();
}
