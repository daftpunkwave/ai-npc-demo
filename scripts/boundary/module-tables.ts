/**
 * 核心职责：规则 9，扫描服务端模块生产源码中的表引用，与按模块登记的表名白名单比对；
 * 未登记的表、无法静态确定的表名以及白名单中已不再引用的表都报违规。
 * 交互契约：输入为规范化路径的源码文件与按目录特异度排序的包清单；白名单与豁免只取自 constants。
 * 表引用有两类：存储事务的 `.table("t")`/`.rows("t")` 调用，以及字符串字面量中 SQL 的
 * FROM/JOIN/INTO/UPDATE 子句（含 FROM 后的逗号表列表）；注释由 lexer 去除，表值函数与 CTE 名不算表。
 * 约束与禁忌：只扫描 modules/server 下各模块的 src，不覆盖宿主与固定机制包；
 * SQL 关键字按仓库约定的大写识别，以 SQL 动词开头的字符串额外按大小写不敏感识别，普通英文文本不被当成 SQL。
 */
import { extname } from "node:path";
import {
  MODULE_TABLE_ALLOWLIST,
  MODULE_TABLE_EXEMPTIONS,
  RULE_MODULE_TABLE,
  SCRIPT_EXTENSIONS,
} from "./constants";
import { violation } from "./finding";
import { isInsideString, stripComments } from "./lexer";
import { parseModuleDirectory } from "./modules";
import { findOwningPackage, isTestFile } from "./package-registry";
import { isSkippedPath, lineAt } from "./paths";
import type { BoundaryPackage, BoundarySourceFile, BoundaryViolation } from "./types";

/** 一处表引用；table 为 null 表示表名来自变量或模板插值，无法静态对账。 */
interface TableReference {
  readonly table: string | null;
  readonly index: number;
}

/** 读到的表名与其后的位置，供 FROM 子句继续读取逗号后的下一张表。 */
interface ParsedTableName {
  readonly table: string | null;
  readonly end: number;
}

const TABLE_ACCESSOR_PATTERN = /\.\s*(?:table|rows)\s*\(\s*/g;
const STATEMENT_START_PATTERN = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i;
// eslint-disable-next-line security/detect-unsafe-regex -- 输入是仓库内源码字符串，可选分支为固定关键字，无嵌套量词。
const UPPERCASE_CLAUSE_PATTERN = /\b(FROM|JOIN|INTO|UPDATE(?:\s+OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE))?)\s+/g;
// eslint-disable-next-line security/detect-unsafe-regex -- 同上，只是大小写不敏感的同一模式。
const ANY_CASE_CLAUSE_PATTERN = /\b(FROM|JOIN|INTO|UPDATE(?:\s+OR\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE))?)\s+/gi;
// eslint-disable-next-line security/detect-unsafe-regex -- 列清单括号内不含括号，量词不嵌套。
const CTE_NAME_PATTERN = /\b([A-Za-z_]\w*)\s*(?:\([^()]*\)\s*)?AS\s*\(/gi;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*/;
// eslint-disable-next-line security/detect-unsafe-regex -- 别名只匹配一个可选 AS 与单个标识符。
const ALIAS_PATTERN = /^\s+(?:AS\s+)?[A-Za-z_]\w*/i;

/**
 * 读取 SQL 文本中 at 处的表名：允许 `"t"`、`[t]` 与 `schema.t` 写法；`${` 开头视为动态表名。
 * 返回 undefined 表示该位置不是表：子查询括号、表值函数，或 `DO UPDATE SET` 中跟在 UPDATE 后的 SET。
 */
function readTableName(sql: string, at: number, columnListMayFollow: boolean): ParsedTableName | undefined {
  if (sql.startsWith("${", at)) {
    return { table: null, end: at + 2 };
  }
  let cursor = at;
  while (sql[cursor] === "\\" || sql[cursor] === "\"" || sql[cursor] === "[") {
    cursor += 1;
  }
  let identifier = IDENTIFIER_PATTERN.exec(sql.slice(cursor))?.[0];
  if (identifier === undefined) {
    return undefined;
  }
  cursor += identifier.length;
  if (sql[cursor] === "." && IDENTIFIER_PATTERN.test(sql.slice(cursor + 1))) {
    identifier = IDENTIFIER_PATTERN.exec(sql.slice(cursor + 1))?.[0] ?? identifier;
    cursor += identifier.length + 1;
  }
  while (sql[cursor] === "\\" || sql[cursor] === "\"" || sql[cursor] === "]") {
    cursor += 1;
  }
  const followedByParenthesis = sql.slice(cursor).trimStart().startsWith("(");
  if ((followedByParenthesis && !columnListMayFollow) || identifier.toLowerCase() === "set") {
    return undefined;
  }
  return { table: identifier.toLowerCase(), end: cursor };
}

/** 从一段 SQL 文本中收集表引用；FROM 子句继续读取逗号分隔的后续表。 */
function sqlTableReferences(sql: string, offset: number): TableReference[] {
  const clausePattern = STATEMENT_START_PATTERN.test(sql) ? ANY_CASE_CLAUSE_PATTERN : UPPERCASE_CLAUSE_PATTERN;
  const cteNames = new Set([...sql.matchAll(CTE_NAME_PATTERN)].map((match) => (match[1] ?? "").toLowerCase()));
  const references: TableReference[] = [];
  for (const match of sql.matchAll(clausePattern)) {
    const keyword = (match[1] ?? "").toUpperCase();
    // INSERT INTO t(col, ...) 的括号是列清单；FROM/JOIN 后紧跟括号的是表值函数，如 json_each。
    const intoOrUpdate = keyword === "INTO" || keyword.startsWith("UPDATE");
    let parsed = readTableName(sql, match.index + match[0].length, intoOrUpdate);
    while (parsed !== undefined) {
      if (parsed.table === null || !cteNames.has(parsed.table)) {
        references.push({ table: parsed.table, index: offset + match.index });
      }
      if (keyword !== "FROM" || parsed.table === null) {
        break;
      }
      let rest = sql.slice(parsed.end);
      rest = rest.slice(ALIAS_PATTERN.exec(rest)?.[0].length ?? 0);
      const comma = /^\s*,\s*/.exec(rest);
      if (comma === null) {
        break;
      }
      parsed = readTableName(sql, sql.length - rest.length + comma[0].length, false);
    }
  }
  return references;
}

/** 收集一个源码文件中的全部表引用：表级接口调用与字符串里的 SQL。 */
function collectTableReferences(source: string): TableReference[] {
  const stripped = stripComments(source);
  const code = stripped.code;
  const references: TableReference[] = [];
  for (const match of code.matchAll(TABLE_ACCESSOR_PATTERN)) {
    if (isInsideString(stripped.stringSpans, match.index)) {
      continue;
    }
    const argumentStart = match.index + match[0].length;
    const quote = code[argumentStart];
    const closing = quote === "\"" || quote === "'" || quote === "`" ? code.indexOf(quote, argumentStart + 1) : -1;
    const literal = closing === -1 ? null : code.slice(argumentStart + 1, closing);
    const isStatic = literal !== null && IDENTIFIER_PATTERN.exec(literal)?.[0] === literal;
    references.push({ table: isStatic ? literal.toLowerCase() : null, index: match.index });
  }
  for (const span of stripped.stringSpans) {
    references.push(...sqlTableReferences(code.slice(span.start + 1, span.end - 1), span.start + 1));
  }
  return references;
}

export function checkModuleTables(
  files: readonly BoundarySourceFile[],
  packagesBySpecificity: readonly BoundaryPackage[],
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const scannedModules = new Map<string, BoundaryPackage>();
  const referencedTables = new Map<string, Set<string>>();

  for (const file of files) {
    if (isSkippedPath(file.path) || !SCRIPT_EXTENSIONS.has(extname(file.path).toLowerCase())) {
      continue;
    }
    const pkg = findOwningPackage(file.path, packagesBySpecificity);
    const modulePath = pkg === undefined ? null : parseModuleDirectory(pkg.directory);
    if (
      pkg === undefined ||
      modulePath === null ||
      modulePath.realm !== "server" ||
      MODULE_TABLE_EXEMPTIONS.has(modulePath.identifier) ||
      !file.path.startsWith(`${pkg.directory}/src/`) ||
      isTestFile(file.path, pkg)
    ) {
      continue;
    }
    const identifier = modulePath.identifier;
    const allowed = MODULE_TABLE_ALLOWLIST.get(identifier) ?? [];
    const seen = referencedTables.get(identifier) ?? new Set<string>();
    referencedTables.set(identifier, seen);
    scannedModules.set(identifier, pkg);
    for (const reference of collectTableReferences(file.content)) {
      const line = lineAt(file.content, reference.index);
      if (reference.table === null) {
        violations.push(
          violation(
            RULE_MODULE_TABLE,
            "module-table-dynamic",
            file.path,
            line,
            `模块 ${identifier} 的表名来自变量或模板插值，无法静态核对表所有权；请把表名写成字面量。`,
          ),
        );
        continue;
      }
      seen.add(reference.table);
      if (!allowed.includes(reference.table)) {
        violations.push(
          violation(
            RULE_MODULE_TABLE,
            "module-table-unlisted",
            file.path,
            line,
            `模块 ${identifier} 引用了表 ${reference.table}，该表不在模块表名白名单中；` +
              "其他所有者的数据应经其提供的 typed port 读取，本模块拥有的表须登记并写明理由。",
          ),
        );
      }
    }
  }

  // 只核对本次有源码参与扫描的模块，夹具只提供部分模块时不会把其他模块的白名单误报为未使用。
  for (const [identifier, pkg] of scannedModules) {
    for (const table of MODULE_TABLE_ALLOWLIST.get(identifier) ?? []) {
      if (referencedTables.get(identifier)?.has(table) !== true) {
        violations.push(
          violation(
            RULE_MODULE_TABLE,
            "module-table-unused",
            `${pkg.directory}/package.json`,
            1,
            `模块 ${identifier} 的表名白名单登记了 ${table}，但源码没有引用该表；请从白名单移除。`,
          ),
        );
      }
    }
  }
  return violations;
}
