/**
 * 轻量词法扫描：去注释并收集静态 import、re-export、动态导入记录。
 * 不构建完整语法树，只保证 import 判定不会被注释或字符串字面量干扰。
 * 禁止在此执行被检查代码、解析模块语义或决定依赖白名单。
 */
import { lineAt } from "./paths";
import type { ImportRecord, StringSpan, StrippedSource } from "./types";

/**
 * 用词法状态机把注释替换为空格并记录字符串区间。
 * 保留字符串原文与换行位置，使行号与后续字面量动态导入解析保持一致。
 */
function stripComments(source: string): StrippedSource {
  const characters = source.split("");
  const stringSpans: StringSpan[] = [];
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  let stringStart = -1;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    const next = characters[index + 1];

    if (mode === "code") {
      if (character === "/" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        mode = "line";
        index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        characters[index] = " ";
        characters[index + 1] = " ";
        mode = "block";
        index += 1;
        continue;
      }
      if (character === '"') {
        mode = "double";
        stringStart = index;
      } else if (character === "'") {
        mode = "single";
        stringStart = index;
      } else if (character === "`") {
        mode = "template";
        stringStart = index;
      }
      continue;
    }

    if (mode === "line") {
      if (character === "\n") {
        mode = "code";
      } else {
        characters[index] = " ";
      }
      continue;
    }

    if (mode === "block") {
      if (character === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        mode = "code";
        index += 1;
      } else if (character !== "\n") {
        characters[index] = " ";
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
      stringSpans.push({ start: stringStart, end: index + 1 });
      mode = "code";
    }
  }

  return { code: characters.join(""), stringSpans };
}

function isInsideString(spans: readonly StringSpan[], index: number): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

/**
 * 收集源码中的静态 import、re-export、字面量动态导入与非字面量动态导入。
 * 匹配起点落在字符串字面量内的视为伪 import 并跳过；类型修饰记入 typeOnly。
 */
export function collectImports(source: string): ImportRecord[] {
  const stripped = stripComments(source);
  const records: ImportRecord[] = [];

  const fromPattern = /\b(import|export)\s+((?:type\s+)?[^;'"]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const match of stripped.code.matchAll(fromPattern)) {
    const matchIndex = match.index ?? 0;
    if (isInsideString(stripped.stringSpans, matchIndex)) {
      continue;
    }
    const specifier = match[3];
    if (specifier === undefined || specifier === "") {
      continue;
    }
    records.push({
      specifier,
      line: lineAt(source, matchIndex),
      kind: match[1] === "export" ? "re-export" : "static",
      typeOnly: /^type\s/.test(match[2] ?? ""),
    });
  }

  const sideEffectPattern = /\bimport\s*["']([^"']+)["']/g;
  for (const match of stripped.code.matchAll(sideEffectPattern)) {
    const matchIndex = match.index ?? 0;
    const specifier = match[1];
    if (specifier === undefined || specifier === "" || isInsideString(stripped.stringSpans, matchIndex)) {
      continue;
    }
    records.push({ specifier, line: lineAt(source, matchIndex), kind: "static", typeOnly: false });
  }

  const dynamicPattern = /\bimport\s*\(\s*/g;
  for (const match of stripped.code.matchAll(dynamicPattern)) {
    const matchIndex = match.index ?? 0;
    if (isInsideString(stripped.stringSpans, matchIndex)) {
      continue;
    }
    const line = lineAt(source, matchIndex);
    const specifierStart = matchIndex + (match[0]?.length ?? 0);
    const opening = stripped.code[specifierStart];
    if (opening === '"' || opening === "'") {
      const closing = stripped.code.indexOf(opening, specifierStart + 1);
      if (closing === -1) {
        records.push({ specifier: "", line, kind: "dynamic-non-literal", typeOnly: false });
        continue;
      }
      records.push({
        specifier: stripped.code.slice(specifierStart + 1, closing),
        line,
        kind: "dynamic",
        typeOnly: false,
      });
      continue;
    }
    if (opening === "`") {
      const closing = stripped.code.indexOf("`", specifierStart + 1);
      const templateBody = closing === -1 ? "" : stripped.code.slice(specifierStart + 1, closing);
      if (closing === -1 || templateBody.includes("${")) {
        records.push({ specifier: "", line, kind: "dynamic-non-literal", typeOnly: false });
      } else {
        records.push({ specifier: templateBody, line, kind: "dynamic", typeOnly: false });
      }
      continue;
    }
    records.push({ specifier: "", line, kind: "dynamic-non-literal", typeOnly: false });
  }

  return records;
}
