/**
 * 校验文档的相对链接、标题锚点与 Markdown 表格列数。
 * 只依赖 Node 内置文件系统与路径模块，从文档所在位置解析目标。
 * 禁止修改文档、访问网络或把外部绝对 URL 当成必须可达的本地目标。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 只扫描仓库内的文档目录与文档内相对链接，路径均由仓库根目录解析。 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface BrokenLink {
  readonly source: string;
  readonly line: number;
  readonly target: string;
  readonly reason: string;
}

interface MarkdownDocument {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly lines: readonly string[];
}

interface TableColumnMismatch {
  readonly source: string;
  readonly line: number;
  readonly expected: number;
  readonly actual: number;
}

interface DocsCliOptions {
  readonly root?: string;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

const scriptPath = fileURLToPath(import.meta.url);
const rootDocuments = ["README.md", "AGENTS.md", "apps/server/README.md"];
const documentationDirectory = "docs";

/** 列出需要检查的 Markdown 文档：仓库入口文档与 docs 目录全量。 */
function collectMarkdownDocuments(repositoryRoot: string): MarkdownDocument[] {
  const absolutePaths = new Set<string>();

  for (const documentName of rootDocuments) {
    const absolutePath = join(repositoryRoot, documentName);
    if (existsSync(absolutePath)) {
      absolutePaths.add(absolutePath);
    }
  }

  const walk = (currentDirectory: string): void => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        absolutePaths.add(absolutePath);
      }
    }
  };

  const docsPath = join(repositoryRoot, documentationDirectory);
  if (existsSync(docsPath) && statSync(docsPath).isDirectory()) {
    walk(docsPath);
  }

  return [...absolutePaths]
    .sort()
    .map((absolutePath) => ({
      absolutePath,
      relativePath: relative(repositoryRoot, absolutePath).split(sep).join("/"),
      lines: readFileSync(absolutePath, "utf8").split(/\r?\n/),
    }));
}

function stripBlockquote(line: string, limit = Number.POSITIVE_INFINITY) {
  let content = line.trimStart();
  let quoteDepth = 0;
  while (quoteDepth < limit && content.startsWith(">")) {
    quoteDepth += 1;
    content = content.slice(1).trimStart();
  }
  return { content, quoteDepth };
}

/** 把围栏代码块替换为空行，保留原始行号。 */
function maskFencedCode(lines: readonly string[]): string[] {
  let fence: { readonly marker: string; readonly quoteDepth: number } | null = null;
  return lines.map((line) => {
    const { content, quoteDepth } = stripBlockquote(line, fence?.quoteDepth);
    const marker = /^(`{3,}|~{3,})/.exec(content)?.[1];

    if (fence !== null && quoteDepth === fence.quoteDepth) {
      if (marker !== undefined && marker.startsWith(fence.marker) && content.slice(marker.length).trim() === "") {
        fence = null;
      }
      return "";
    }

    fence = marker === undefined ? null : { marker, quoteDepth };
    return fence === null ? line : "";
  });
}

function maskCode(lines: readonly string[]): string[] {
  return maskFencedCode(lines).map((line) => line.replace(/`[^`\n]*`/g, ""));
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  const cells: string[] = [];
  let cellStart = 0;

  // 先消费反斜杠转义的字符，只让未转义的竖线分隔单元格。
  for (const match of trimmed.matchAll(/\\.|\|/g)) {
    if (match[0] !== "|") {
      continue;
    }
    if (match.index > 0) {
      cells.push(trimmed.slice(cellStart, match.index).trim());
    }
    cellStart = match.index + 1;
  }

  if (cellStart === 0) {
    return null;
  }
  if (cellStart < trimmed.length) {
    cells.push(trimmed.slice(cellStart).trim());
  }
  return cells;
}

function endsTable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" ||
    /^(?:#{1,6}(?:\s|$)|[-+*]\s|\d{1,9}[.)]\s|<!--)/.test(trimmed) ||
    /^(?:\*{3,}|-{3,}|_{3,})$/.test(trimmed.replace(/[ \t]/g, ""));
}

function findTableColumnMismatches(documents: readonly MarkdownDocument[]) {
  const mismatches: TableColumnMismatch[] = [];
  let tableCount = 0;

  for (const document of documents) {
    let previousRow: string[] | null = null;
    let expectedColumns = 0;
    let previousQuoteDepth = 0;
    for (const [index, line] of maskFencedCode(document.lines).entries()) {
      const { content, quoteDepth } = stripBlockquote(line);
      const boundary = endsTable(content);
      if (boundary || quoteDepth !== previousQuoteDepth) {
        previousRow = null;
        expectedColumns = 0;
      }
      previousQuoteDepth = quoteDepth;
      if (boundary) {
        continue;
      }

      const cells = splitTableRow(content);
      if (expectedColumns > 0) {
        const actual = cells?.length ?? 1;
        if (actual !== expectedColumns) {
          mismatches.push({ source: document.relativePath, line: index + 1, expected: expectedColumns, actual });
        }
        continue;
      }

      if (previousRow !== null && cells !== null && cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))) {
        tableCount += 1;
        expectedColumns = cells.length;
        if (previousRow.length !== expectedColumns) {
          mismatches.push({ source: document.relativePath, line: index, expected: expectedColumns, actual: previousRow.length });
        }
      }
      previousRow = cells;
    }
  }

  return { tableCount, mismatches };
}

/** 把标题文本规范化为锚点：小写，仅保留字母、数字、空格与连字符，空格转为连字符。 */
function toAnchor(headingText: string): string {
  return headingText
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

/** 收集文档中所有标题锚点。 */
function collectAnchors(lines: readonly string[]): Set<string> {
  const anchors = new Set<string>();

  for (const line of maskCode(lines)) {
    const headingMatch = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (headingMatch?.[1] !== undefined) {
      anchors.add(toAnchor(headingMatch[1]));
    }
  }

  return anchors;
}

/** 提取一行中的所有内联链接目标，图片链接与外部 URL 由调用方过滤。 */
function extractLinkTargets(line: string): string[] {
  const targets: string[] = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]*)\)/g;

  for (const match of line.matchAll(linkPattern)) {
    const rawTarget = match[1];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
    if (rawTarget === undefined) {
      continue;
    }

    const trimmed = rawTarget.trim();
    if (trimmed.startsWith("<")) {
      const closingIndex = trimmed.indexOf(">");
      targets.push(closingIndex === -1 ? trimmed : trimmed.slice(1, closingIndex));
      continue;
    }

    const titleSeparator = /\s+"/.exec(trimmed);
    targets.push(titleSeparator === null ? trimmed : trimmed.slice(0, titleSeparator.index));
  }

  return targets;
}

/** 判断目标是否为外部 URL 或其他不应做本地检查的协议前缀。 */
function isExternalTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/** 安全解码 URL 片段，非法编码时保留原文。 */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** 检查一个相对链接，返回失败原因；合法时返回 null。 */
function inspectLink(
  document: MarkdownDocument,
  target: string,
  anchorCache: Map<string, Set<string>>,
): string | null {
  const hashIndex = target.indexOf("#");
  const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const rawAnchor = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  const decodedPath = decodeFragment(rawPath);

  let targetAbsolutePath: string;
  if (decodedPath === "") {
    targetAbsolutePath = document.absolutePath;
  } else {
    targetAbsolutePath = resolve(dirname(document.absolutePath), decodedPath);
  }

  if (!existsSync(targetAbsolutePath)) {
    return "目标文件不存在";
  }

  if (rawAnchor === "" || !targetAbsolutePath.endsWith(".md")) {
    return null;
  }

  const anchor = toAnchor(rawAnchor);
  let anchors = anchorCache.get(targetAbsolutePath);
  if (anchors === undefined) {
    anchors = collectAnchors(readFileSync(targetAbsolutePath, "utf8").split(/\r?\n/));
    anchorCache.set(targetAbsolutePath, anchors);
  }

  return anchors.has(anchor) ? null : "目标标题锚点不存在";
}

/** 检查全部文档，返回坏链接清单。 */
function findBrokenLinks(documents: readonly MarkdownDocument[]) {
  const brokenLinks: BrokenLink[] = [];
  const anchorCache = new Map<string, Set<string>>();
  let checkedLinkCount = 0;

  for (const document of documents) {
    const maskedLines = maskCode(document.lines);

    maskedLines.forEach((line, index) => {
      for (const target of extractLinkTargets(line)) {
        if (target === "" || target.startsWith("//") || isExternalTarget(target)) {
          continue;
        }

        checkedLinkCount += 1;
        const reason = inspectLink(document, target, anchorCache);
        if (reason !== null) {
          brokenLinks.push({
            source: document.relativePath,
            line: index + 1,
            target,
            reason,
          });
        }
      }
    });
  }

  return { checkedLinkCount, brokenLinks };
}

export function runDocsCheckCli(options: DocsCliOptions = {}): number {
  const repositoryRoot = resolve(options.root ?? join(dirname(scriptPath), ".."));
  const documents = collectMarkdownDocuments(repositoryRoot);
  const { checkedLinkCount, brokenLinks } = findBrokenLinks(documents);
  const { tableCount, mismatches } = findTableColumnMismatches(documents);
  const writeStdout = options.writeStdout ?? ((message: string) => process.stdout.write(message));
  const writeStderr = options.writeStderr ?? ((message: string) => process.stderr.write(message));

  writeStdout(`扫描 ${documents.length} 个文档，检查 ${checkedLinkCount} 条相对链接。\n`);
  writeStdout(`检查 ${tableCount} 张 Markdown 表格。\n`);
  if (brokenLinks.length > 0) {
    writeStderr(`发现 ${brokenLinks.length} 条坏链接：\n`);
    for (const link of brokenLinks) {
      writeStderr(`  ${link.source}:${link.line} -> ${link.target}（${link.reason}）\n`);
    }
  }
  if (mismatches.length > 0) {
    writeStderr(`发现 ${mismatches.length} 行表格列数错误：\n`);
    for (const issue of mismatches) {
      writeStderr(`  ${issue.source}:${issue.line} 期望 ${issue.expected} 列，实际 ${issue.actual} 列。\n`);
    }
  }

  if (brokenLinks.length > 0 || mismatches.length > 0) {
    return 1;
  }
  writeStdout("文档链接、锚点与表格列数检查通过。\n");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runDocsCheckCli();
}
