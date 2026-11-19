/**
 * 规则 7：检查手写源码文件头的原生格式、中文说明与注释引用禁忌。
 * 按扩展名选择语言原生注释；注释里只允许解释代码本身，判定为启发式后仍需人工复核。
 * 禁止修改被检查文件、把数据配置当成源码或因为目录可写而放宽格式要求。
 */
/* eslint-disable security/detect-object-injection -- 索引均来自本文件扫描的源文本字符下标或固定映射表，不来自外部输入。 */
import { extname } from "node:path";
import { FORBIDDEN_COMMENT_PATTERNS } from "./header-comments";
import { HEADER_LANGUAGE_BY_EXTENSION, RULE_SOURCE_HEADER } from "./constants";
import { violation } from "./finding";
import { lineAt } from "./paths";
import type { BoundaryViolation, CommentSpan, HeaderLanguage, HeaderReadResult } from "./types";

function firstNonWhitespaceIndex(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function lineStartsOf(source: string, from: number): number[] {
  const lineStarts: number[] = [];
  let index = from;
  while (index <= source.length) {
    lineStarts.push(index);
    const newline = source.indexOf("\n", index);
    if (newline === -1) {
      break;
    }
    index = newline + 1;
  }
  return lineStarts;
}

function lineTextAt(source: string, lineStarts: readonly number[], lineIndex: number): string {
  const start = lineStarts[lineIndex] ?? 0;
  const end =
    lineIndex + 1 < lineStarts.length ? (lineStarts[lineIndex + 1] ?? source.length) - 1 : source.length;
  return source.slice(start, end);
}

/** 读取 SQL 与 shell 的连续行注释头；首个非注释行即视为文件头结束。 */
function readCommentLines(source: string, from: number, marker: "--" | "#"): HeaderReadResult {
  const lineStarts = lineStartsOf(source, from);
  let firstContentLine = -1;
  for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex += 1) {
    if (lineTextAt(source, lineStarts, lineIndex).trim() !== "") {
      firstContentLine = lineIndex;
      break;
    }
  }
  if (firstContentLine === -1) {
    return { status: "missing", index: from };
  }

  const headerLineIndices: number[] = [];
  for (let lineIndex = firstContentLine; lineIndex < lineStarts.length; lineIndex += 1) {
    if (lineTextAt(source, lineStarts, lineIndex).trimStart().startsWith(marker)) {
      headerLineIndices.push(lineIndex);
    } else {
      break;
    }
  }

  const start = lineStarts[firstContentLine] ?? from;
  if (headerLineIndices.length === 0) {
    return { status: "missing", index: start };
  }
  const lastLineIndex = headerLineIndices[headerLineIndices.length - 1] ?? firstContentLine;
  const headerEnd =
    lastLineIndex + 1 < lineStarts.length ? (lineStarts[lastLineIndex + 1] ?? source.length) - 1 : source.length;
  return { status: "ok", text: source.slice(start, headerEnd), contentStart: start };
}

/** 取出语言原生注释头；有 shebang 时从 shebang 之后开始查找。 */
function readHeader(source: string, language: HeaderLanguage): HeaderReadResult {
  const shebangEnd = source.startsWith("#!")
    ? source.indexOf("\n") === -1
      ? source.length
      : source.indexOf("\n") + 1
    : 0;

  if (language === "sql") {
    return readCommentLines(source, shebangEnd, "--");
  }
  if (language === "shell") {
    return readCommentLines(source, shebangEnd, "#");
  }
  if (language === "python") {
    const start = firstNonWhitespaceIndex(source, shebangEnd);
    const opener = source.startsWith('"""', start) ? '"""' : source.startsWith("'''", start) ? "'''" : null;
    if (opener === null) {
      return { status: "missing", index: start };
    }
    const closing = source.indexOf(opener, start + 3);
    if (closing === -1) {
      return { status: "invalid-format", index: start };
    }
    return { status: "ok", text: source.slice(start + 3, closing), contentStart: start + 3 };
  }

  const start = firstNonWhitespaceIndex(source, shebangEnd);
  if (language === "typescript") {
    if (!source.startsWith("/**", start)) {
      return { status: source.startsWith("/*", start) ? "invalid-format" : "missing", index: start };
    }
    const closing = source.indexOf("*/", start + 3);
    if (closing === -1) {
      return { status: "invalid-format", index: start };
    }
    return { status: "ok", text: source.slice(start + 3, closing), contentStart: start + 3 };
  }
  if (language === "css") {
    if (!source.startsWith("/*", start)) {
      return { status: "missing", index: start };
    }
    const closing = source.indexOf("*/", start + 2);
    if (closing === -1) {
      return { status: "invalid-format", index: start };
    }
    return { status: "ok", text: source.slice(start + 2, closing), contentStart: start + 2 };
  }
  if (!source.startsWith("<!--", start)) {
    return { status: "missing", index: start };
  }
  const closing = source.indexOf("-->", start + 4);
  if (closing === -1) {
    return { status: "invalid-format", index: start };
  }
  return { status: "ok", text: source.slice(start + 4, closing), contentStart: start + 4 };
}

/** 逐行扫描 SQL、shell 与 Python 的行注释，跳过简单字符串字面量。 */
function collectLineCommentSpans(source: string, marker: "--" | "#"): CommentSpan[] {
  const spans: CommentSpan[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === '"' || character === "'") {
      const quote = character;
      index += 1;
      while (index < source.length) {
        const inside = source[index] ?? "";
        if (inside === "\\") {
          index += 2;
          continue;
        }
        if (inside === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    const isMarker = marker === "--" ? character === "-" && source[index + 1] === "-" : character === "#";
    if (!isMarker) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < source.length && source[index] !== "\n") {
      index += 1;
    }
    spans.push({ text: source.slice(start, index), start });
  }
  return spans;
}

/** 扫描块注释（含 HTML 注释），并跳过字符串字面量。 */
function collectDelimitedCommentSpans(source: string, language: HeaderLanguage): CommentSpan[] {
  const spans: CommentSpan[] = [];
  // eslint-disable-next-line xss/no-mixed-html -- html 是布尔判定变量，不是 HTML 片段。
  const html = language === "html";
  type Mode = "code" | "line" | "block" | "html" | "single" | "double" | "template";
  let mode: Mode = "code";
  let start = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1];

    if (mode === "code") {
      if (!html && character === "/" && next === "/") {
        mode = "line";
        start = index;
        index += 1;
        continue;
      }
      if (!html && character === "/" && next === "*") {
        mode = "block";
        start = index;
        index += 1;
        continue;
      }
      if (html && character === "<" && source.startsWith("<!--", index)) {
        mode = "html";
        start = index;
        index += 3;
        continue;
      }
      if (character === '"') {
        mode = "double";
      } else if (character === "'") {
        mode = "single";
      } else if (character === "`") {
        mode = "template";
      }
      continue;
    }

    if (mode === "line") {
      if (character === "\n") {
        spans.push({ text: source.slice(start, index), start });
        mode = "code";
      }
      continue;
    }
    if (mode === "block") {
      if (character === "*" && next === "/") {
        spans.push({ text: source.slice(start, index + 2), start });
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "html") {
      if (character === "-" && next === "-" && source[index + 2] === ">") {
        spans.push({ text: source.slice(start, index + 3), start });
        mode = "code";
        index += 2;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    const closes =
      (mode === "single" && character === "'") ||
      (mode === "double" && character === '"') ||
      (mode === "template" && character === "`");
    if (closes) {
      mode = "code";
    }
  }

  if (mode === "line" || mode === "block" || mode === "html") {
    spans.push({ text: source.slice(start), start });
  }
  return spans;
}

function collectCommentSpans(source: string, language: HeaderLanguage): CommentSpan[] {
  if (language === "sql" || language === "shell" || language === "python") {
    return collectLineCommentSpans(source, language === "sql" ? "--" : "#");
  }
  return collectDelimitedCommentSpans(source, language);
}

function compactHeaderDescription(headerText: string): string {
  return headerText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s*/, "").trim())
    .join(" ")
    .trim();
}

/**
 * 检查一个文件的文件头与全部注释。
 * 中文说明只做存在性启发式判断，职责与依赖描述是否准确仍需人工复核。
 */
export function checkFileHeader(filePath: string, content: string): readonly BoundaryViolation[] {
  const language = HEADER_LANGUAGE_BY_EXTENSION[extname(filePath).toLowerCase()];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
  if (language === undefined) {
    return [];
  }
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const violations: BoundaryViolation[] = [];
  const header = readHeader(source, language);

  if (header.status !== "ok") {
    violations.push(
      violation(
        RULE_SOURCE_HEADER,
        header.status === "missing" ? "header-missing" : "header-invalid-format",
        filePath,
        lineAt(source, header.index),
        header.status === "missing"
          ? "手写源码文件首缺少语言原生的注释文件头。"
          : "文件头格式不符合语言原生注释块要求。",
      ),
    );
  } else {
    const description = compactHeaderDescription(header.text);
    if (description === "") {
      violations.push(
        violation(
          RULE_SOURCE_HEADER,
          "header-missing-description",
          filePath,
          lineAt(source, header.contentStart),
          "文件头没有说明性文字。",
        ),
      );
    } else if (!/[\u4e00-\u9fff]/u.test(description)) {
      violations.push(
        violation(
          RULE_SOURCE_HEADER,
          "header-missing-chinese",
          filePath,
          lineAt(source, header.contentStart),
          "文件头缺少中文说明。",
        ),
      );
    }
  }

  const spans = collectCommentSpans(source, language);
  const checkedSpans: readonly CommentSpan[] =
    language === "python" && header.status === "ok"
      ? [...spans, { text: header.text, start: header.contentStart }]
      : spans;
  for (const span of checkedSpans) {
    for (const forbidden of FORBIDDEN_COMMENT_PATTERNS) {
      const match = forbidden.pattern.exec(span.text);
      if (match === null) {
        continue;
      }
      violations.push(
        violation(
          RULE_SOURCE_HEADER,
          forbidden.code,
          filePath,
          lineAt(source, span.start + match.index),
          `注释引用无法被代码本身解释的${forbidden.label}，只应说明代码职责与约束。`,
        ),
      );
    }
  }
  return violations;
}
