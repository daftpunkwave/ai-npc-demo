/**
 * 核心职责：定义注释中文要求、冻结迁移范围与文件头类别完整性策略。
 * 交互契约：接收注释原文和仓库相对路径，返回是否违规或是否受冻结规则保护。
 * 约束与禁忌：不读写文件、不定位行号，也不执行被检查内容。
 */

const FROZEN_MIGRATION_DIRECTORY = "modules/server/platform/storage/sqlite/migrations/";
// 已发布迁移参与内容校验和；新增迁移仍接受完整的文件头与中文注释检查。
const FROZEN_MIGRATION_VERSION_LIMIT = 11;

function commentBody(comment: string): string {
  return comment
    .replace(/^\/\*+/, "")
    .replace(/\*\/$/, "")
    .replace(/^\/\/+/, "")
    .replace(/^<!--/, "")
    .replace(/-->$/, "")
    .replace(/^\s*(?:--|#)+/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s*/, "").trim())
    .filter((line) => line !== "")
    .join(" ")
    .trim();
}

function directiveExplanation(body: string): string | null {
  if (
    (body.charAt(0) === "<" && body.startsWith("reference", 1)) ||
    body === "nosemgrep" ||
    body.startsWith("nosemgrep:") ||
    body.startsWith("@vitest-environment") ||
    body.startsWith("prettier-ignore") ||
    body.startsWith("c8 ignore") ||
    body.startsWith("istanbul ignore") ||
    body.startsWith("v8 ignore") ||
    body.startsWith("sourceMappingURL=")
  ) {
    return null;
  }
  const typescriptDirective = ["@ts-expect-error", "@ts-ignore", "@ts-nocheck"].find(
    (directive) => body === directive || body.startsWith(`${directive} `),
  );
  if (typescriptDirective !== undefined) {
    const withoutDirective = body.slice(typescriptDirective.length).trim();
    return withoutDirective === "" ? null : withoutDirective;
  }
  if (body.startsWith("eslint-disable") || body.startsWith("eslint-enable")) {
    const separator = body.indexOf("--");
    return separator === -1 ? null : body.slice(separator + 2).trim();
  }
  return body;
}

function containsAsciiWord(text: string): boolean {
  let letters = 0;
  for (const character of text) {
    if ((character >= "A" && character <= "Z") || (character >= "a" && character <= "z")) {
      letters += 1;
      if (letters >= 2) {
        return true;
      }
    }
  }
  return false;
}

export function commentNeedsChinese(comment: string): boolean {
  const explanation = directiveExplanation(commentBody(comment));
  return explanation !== null && containsAsciiWord(explanation);
}

export function isFrozenMigration(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (!normalized.startsWith(FROZEN_MIGRATION_DIRECTORY)) {
    return false;
  }
  const match = /^(\d{4})_.*\.sql$/u.exec(normalized.slice(FROZEN_MIGRATION_DIRECTORY.length));
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
  return match !== null && Number(match[1]) <= FROZEN_MIGRATION_VERSION_LIMIT;
}

function startsWithLabel(line: string, labels: readonly string[]): boolean {
  return labels.some((label) => line.startsWith(`${label}：`) || line.startsWith(`${label}:`));
}

export function headerIsIncomplete(lines: readonly string[]): boolean {
  if (lines.length < 3 || new Set(lines).size < 3) {
    return true;
  }
  const labeled = lines.some((line) =>
    startsWithLabel(line, ["核心职责", "职责", "交互契约", "依赖契约", "契约", "约束与禁忌", "约束", "禁忌"]),
  );
  if (!labeled) {
    return false;
  }
  return !(
    lines.some((line) => startsWithLabel(line, ["核心职责", "职责"])) &&
    lines.some((line) => startsWithLabel(line, ["交互契约", "依赖契约", "契约"])) &&
    lines.some((line) => startsWithLabel(line, ["约束与禁忌", "约束", "禁忌"]))
  );
}
