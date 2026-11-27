/**
 * 核心职责：为模块源码的能力访问扫描提供与语义无关的词法原语：空白、标识符、字符串、换行计数与括号配对。
 * 交互契约：输入为源码文本与位置下标，只返回位置、计数或片段，不判断某处是否在取用能力。
 * 约束与禁忌：不执行源码、不读文件，也不引入能力 ID 或端口容器等对账语义。
 */

const whitespaceCharacters: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"]);

export function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && whitespaceCharacters.has(character);
}

export function isIdentifierCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }
  const isLowercase = character >= "a" && character <= "z";
  const isUppercase = character >= "A" && character <= "Z";
  const isDigit = character >= "0" && character <= "9";
  return isLowercase || isUppercase || isDigit || character === "_" || character === "$";
}

export function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index += 1) {
    if (text[index] === "\n") {
      count += 1;
    }
  }
  return count;
}

/** 跳过空白字符，返回下一个有效位置与经过的换行数。 */
export function skipTrivia(
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
export function skipStringLiteral(text: string, from: number): number {
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
export function previousWord(text: string, index: number): string {
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

/** 返回指定位置之前最近的非空白字符位置；没有时返回 -1。 */
export function previousSignificantIndex(text: string, index: number): number {
  let cursor = index - 1;
  while (cursor >= 0 && isWhitespace(text[cursor])) {
    cursor -= 1;
  }
  return cursor;
}

/** 返回指定位置之前最近的代码字符，用于区分索引访问与声明数组。 */
export function previousSignificantChar(text: string, index: number): string {
  const at = previousSignificantIndex(text, index);
  return at < 0 ? "" : (text[at] ?? "");
}

/** 返回 end 处结束的标识符；end 处不是标识符字符时返回空串。 */
export function identifierEndingAt(text: string, end: number): string {
  let start = end;
  while (start >= 0 && isIdentifierCharacter(text[start])) {
    start -= 1;
  }
  return text.slice(start + 1, end + 1);
}

/** 从 closeIndex 处的 `)` 向前找到配对的 `(`；不配对时返回 -1。 */
export function matchingOpenParenthesis(text: string, closeIndex: number): number {
  let depth = 0;
  for (let cursor = closeIndex; cursor >= 0; cursor -= 1) {
    if (text[cursor] === ")") {
      depth += 1;
    } else if (text[cursor] === "(") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
  }
  return -1;
}
