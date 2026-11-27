/**
 * 核心职责：规则 8，检查名单内的跨包共享契约只由登记的所有者包声明，其他包的同名声明报违规，
 * 并在所有者包有源码参与扫描时核对名单中的名字仍有声明，防止名单过期后静默失效。
 * 交互契约：输入为规范化路径的源码文件与按目录特异度排序的包清单；名单与所有者只取自 constants，
 * 声明识别复用 lexer 的去注释文本与字符串区间，注释和字符串里出现的同名文字不算声明；
 * 源码按标识符记号逐字符切分后检查「关键字 + 名字」的相邻关系，不用带回溯的正则，耗时与源码长度成线性。
 * 约束与禁忌：只按名字识别 interface/type/class/enum/函数/变量声明，不比较结构；测试、验证包与工具配置不参与；
 * 浏览器 realm 不能导入服务端专属包，因此服务端专属所有者的名字对浏览器源码不生效。
 */
import { extname } from "node:path";
import {
  RULE_SHARED_CONTRACT,
  SCRIPT_EXTENSIONS,
  SERVER_ONLY_WORKSPACE_PACKAGES,
  SHARED_CONTRACT_OWNERS,
} from "./constants";
import { violation } from "./finding";
import { isInsideString, stripComments } from "./lexer";
import { findOwningPackage, isRootPackage, isTestFile, isVerificationPackage } from "./package-registry";
import { isBrowserRealmFile, isSkippedPath, isToolConfigFile, lineAt } from "./paths";
import type { BoundaryPackage, BoundarySourceFile, BoundaryViolation } from "./types";

interface ContractDeclaration {
  readonly name: string;
  readonly line: number;
}

/** 源码中的一个词：连续的标识符字符（字母、数字、`_`、`$`）；数字开头的词不是标识符。 */
interface WordToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && (char === "_" || char === "$" || (char >= "0" && char <= "9") ||
    (char >= "A" && char <= "Z") || (char >= "a" && char <= "z"));
}

/** 逐字符切出全部词；与正则 `\b` 一致，词的边界只落在标识符字符与其他字符之间。 */
function wordTokens(code: string): WordToken[] {
  const tokens: WordToken[] = [];
  let cursor = 0;
  while (cursor < code.length) {
    if (!isWordChar(code[cursor])) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (isWordChar(code[cursor])) {
      cursor += 1;
    }
    tokens.push({ text: code.slice(start, cursor), start, end: cursor });
  }
  return tokens;
}

function isIdentifierToken(token: WordToken): boolean {
  const first = token.text[0] ?? "";
  return first < "0" || first > "9";
}

/** 从 at 起第一个非空白字符；空白集合与正则 `\s` 一致。 */
function nextNonWhitespace(code: string, at: number): string | undefined {
  let cursor = at;
  while (cursor < code.length && (code[cursor] ?? "").trim().length === 0) {
    cursor += 1;
  }
  return code[cursor];
}

/** 两个词之间是否只有至少一个空白字符。 */
function separatedByWhitespace(code: string, left: WordToken, right: WordToken): boolean {
  return right.start > left.end && code.slice(left.end, right.start).trim().length === 0;
}

/**
 * 判断 name 是否是紧跟在 keyword 后、会引入新绑定名的声明：
 * - interface、class、enum 与 function（含生成器的 `*`）；
 * - const/let/var 后的单个标识符（`const enum` 由下一对 `enum X` 识别）；
 * - `type X =` 与 `type X<...> =`；`import { type X }` 中的类型修饰后面不跟 `=` 或 `<`，不算声明。
 */
function declaresName(code: string, keyword: WordToken, name: WordToken): boolean {
  if (!isIdentifierToken(name)) {
    return false;
  }
  switch (keyword.text) {
    case "interface":
    case "class":
    case "enum":
      return separatedByWhitespace(code, keyword, name);
    case "function": {
      const between = code.slice(keyword.end, name.start).trim();
      return between === "" || between === "*";
    }
    case "const":
    case "let":
    case "var":
      return name.text !== "enum" && separatedByWhitespace(code, keyword, name);
    case "type": {
      const following = nextNonWhitespace(code, name.end);
      return separatedByWhitespace(code, keyword, name) && (following === "<" || following === "=");
    }
    default:
      return false;
  }
}

/** 收集源码中声明了名单内名字的位置；先按名单过滤再计算行号，避免对每个声明逐字符数行。 */
function collectContractDeclarations(source: string): ContractDeclaration[] {
  const stripped = stripComments(source);
  const code = stripped.code;
  const tokens = wordTokens(code);
  const declarations: ContractDeclaration[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const keyword = tokens[index - 1];
    const name = tokens[index];
    if (keyword === undefined || name === undefined || !SHARED_CONTRACT_OWNERS.has(name.text)) {
      continue;
    }
    if (!declaresName(code, keyword, name) || isInsideString(stripped.stringSpans, keyword.start)) {
      continue;
    }
    declarations.push({ name: name.text, line: lineAt(source, keyword.start) });
  }
  return declarations;
}

/** 只有 workspace 包的生产源码参与：根包、验证包、测试与工具配置不承载公共契约。 */
function isProductionSource(filePath: string, pkg: BoundaryPackage): boolean {
  return !isRootPackage(pkg) && !isVerificationPackage(pkg) && !isTestFile(filePath, pkg) && !isToolConfigFile(filePath);
}

export function checkSharedContracts(
  files: readonly BoundarySourceFile[],
  packagesBySpecificity: readonly BoundaryPackage[],
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const scannedPackages = new Set<string>();
  const declaredByOwner = new Set<string>();

  for (const file of files) {
    if (isSkippedPath(file.path) || !SCRIPT_EXTENSIONS.has(extname(file.path).toLowerCase())) {
      continue;
    }
    const pkg = findOwningPackage(file.path, packagesBySpecificity);
    if (pkg === undefined || !isProductionSource(file.path, pkg)) {
      continue;
    }
    scannedPackages.add(pkg.name);
    for (const declaration of collectContractDeclarations(file.content)) {
      const owner = SHARED_CONTRACT_OWNERS.get(declaration.name) ?? "";
      if (owner === pkg.name) {
        declaredByOwner.add(declaration.name);
        continue;
      }
      if (isBrowserRealmFile(file.path) && SERVER_ONLY_WORKSPACE_PACKAGES.has(owner)) {
        continue;
      }
      violations.push(
        violation(
          RULE_SHARED_CONTRACT,
          "shared-contract-redeclared",
          file.path,
          declaration.line,
          `${declaration.name} 是 ${owner} 拥有的共享契约，${pkg.name} 不得再声明同名类型或 schema；请从 ${owner} 导入。`,
        ),
      );
    }
  }

  // 夹具只提供部分包的源码时无法判断所有者是否声明；所有者包有源码参与扫描时才核对名单是否过期。
  for (const [name, owner] of SHARED_CONTRACT_OWNERS) {
    if (!scannedPackages.has(owner) || declaredByOwner.has(name)) {
      continue;
    }
    const ownerDirectory = packagesBySpecificity.find((pkg) => pkg.name === owner)?.directory ?? owner;
    violations.push(
      violation(
        RULE_SHARED_CONTRACT,
        "shared-contract-owner-missing",
        `${ownerDirectory}/package.json`,
        1,
        `共享契约名单登记 ${name} 归 ${owner} 所有，但该包源码中没有这个声明；请恢复声明或更新名单。`,
      ),
    );
  }
  return violations;
}
