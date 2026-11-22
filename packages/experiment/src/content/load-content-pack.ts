/**
 * 从磁盘读取并解析内容包，返回经过 schema 与交叉检查校验的只读视图。
 * 依赖 yaml 解析、内容 schema、索引构建与注入的内容根目录；不依赖配置或运行时状态。
 * 禁止在缺少声明文件时用默认值补齐，也不接受未登记的顶层资源文件。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { LoadingError, schemaLoadingError } from "../loading/errors";
import { parseYamlText } from "../loading/yaml";
import { type ContentIndex, buildContentIndex, type ContentParts } from "./content-index";
import {
  contentCharactersSchema,
  type ContentCharacters,
  contentEvidenceSchema,
  type ContentEvidence,
  contentFactionsSchema,
  type ContentFactions,
  contentLocaleSchema,
  type ContentLocale,
  contentLoreSchema,
  type ContentLore,
  contentMapSchema,
  type ContentMap,
  contentPackSchema,
  type ContentPackFile,
  contentPromptsSchema,
  type ContentPrompts,
  contentRulesSchema,
  type ContentRules,
  contentScenarioSchema,
  type ContentScenario,
  contentScriptSchema,
  type ContentScript,
  contentStartsSchema,
  type ContentStarts,
  contentWorldInitSchema,
  type ContentWorldInit,
} from "./schema/index";

/** 内容包清单文件的固定相对路径。 */
const packFileName = "pack.yaml";

/** 内容包根目录下的必需文件；顺序仅用于错误信息展示。 */
const requiredFileNames = [
  "lore.yaml",
  "map.yaml",
  "factions.yaml",
  "characters.yaml",
  "world-init.yaml",
  "rules.yaml",
  "evidence.yaml",
  "starts.yaml",
  "prompts/zh-CN.yaml",
  "locale/zh-CN.yaml",
] as const;

/** 内容包读取结果：包标识与相对路径到 YAML 文本的映射。 */
export interface ContentPackSources {
  readonly packId: string;
  readonly files: ReadonlyMap<string, string>;
}

/** 解析并交叉检查后的内容包；索引供运行时按 ID 查询。 */
export interface ContentPack extends ContentParts {
  readonly index: ContentIndex;
}

/** 按 schema 解析一份 YAML 文本，失败时保留来源文件与字段路径。 */
function parseDocument<T>(schema: z.ZodType<T>, text: string, source: string): T {
  const value = parseYamlText(text, source);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw schemaLoadingError(source, result.error);
  }
  return result.data;
}

/** 读取文本文件；缺失文件按加载错误报告，其余 IO 错误不伪装成缺失。 */
function readTextFile(filePath: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 路径由已校验的 packId 与固定文件清单拼出。
    return readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new LoadingError({ code: "missing-file", source: filePath, message: "文件不存在" });
    }
    throw new LoadingError({ code: "reference", source: filePath, message });
  }
}

/** 在读取文件前校验包 ID 与声明路径，避免路径穿越与读取未登记文件。 */
function checkDeclaredFiles(pack: ContentPackFile): void {
  const seen = new Set<string>();
  for (const [index, fileName] of pack.files.entries()) {
    if (seen.has(fileName)) {
      throw new LoadingError({
        code: "cross-check",
        source: packFileName,
        path: `files.${index}`,
        message: `文件「${fileName}」重复声明`,
      });
    }
    seen.add(fileName);
    if (!(requiredFileNames as readonly string[]).includes(fileName)) {
      throw new LoadingError({
        code: "unexpected-file",
        source: packFileName,
        path: `files.${index}`,
        message: `未登记的内容文件「${fileName}」`,
      });
    }
  }
  for (const fileName of requiredFileNames) {
    if (!seen.has(fileName)) {
      throw new LoadingError({
        code: "missing-file",
        source: packFileName,
        path: "files",
        message: `缺少必需的内容文件「${fileName}」`,
      });
    }
  }
  const checkList = (list: readonly string[], key: string, pattern: RegExp): void => {
    const listSeen = new Set<string>();
    list.forEach((relPath, index) => {
      if (listSeen.has(relPath)) {
        throw new LoadingError({
          code: "cross-check",
          source: packFileName,
          path: `${key}.${index}`,
          message: `路径「${relPath}」重复声明`,
        });
      }
      listSeen.add(relPath);
      if (!pattern.test(relPath)) {
        throw new LoadingError({
          code: "unexpected-file",
          source: packFileName,
          path: `${key}.${index}`,
          message: `文件路径「${relPath}」不符合约定`,
        });
      }
    });
  };
  checkList(pack.scenarios, "scenarios", /^scenarios\/[a-z0-9-]+\.yaml$/);
  checkList(pack.scripts, "scripts", /^scripts\/[a-z0-9-]+\.yaml$/);
}

/** 从内容根目录读取 pack.yaml 声明的全部文件，返回相对路径到文本的映射。 */
export function readContentPackSources(contentRoot: string, packId: string): ContentPackSources {
  if (!/^[a-z][a-z0-9-]*$/.test(packId)) {
    throw new LoadingError({ code: "reference", source: packId, message: "内容包 ID 不合法" });
  }
  const packDir = join(contentRoot, "world-packs", packId);
  const packRelPath = packFileName;
  const packText = readTextFile(join(packDir, packRelPath));
  const pack = parseDocument(contentPackSchema, packText, packRelPath);
  checkDeclaredFiles(pack);
  const files = new Map<string, string>([[packRelPath, packText]]);
  for (const relPath of [...pack.files, ...pack.scenarios, ...pack.scripts]) {
    files.set(relPath, readTextFile(join(packDir, relPath)));
  }
  return { packId, files };
}

/** 取声明文件的文本；缺失时给出 pack.yaml 与该路径。 */
function requireFile(sources: ContentPackSources, relPath: string): string {
  const text = sources.files.get(relPath);
  if (text === undefined) {
    throw new LoadingError({
      code: "missing-file",
      source: relPath,
      message: "pack.yaml 声明的文件未读取到",
    });
  }
  return text;
}

/** 解析并交叉检查内容包，不访问文件系统；测试可传入篡改后的文件映射。 */
export function parseContentPack(sources: ContentPackSources): ContentPack {
  const pack = parseDocument(contentPackSchema, requireFile(sources, packFileName), packFileName);
  if (pack.packId !== sources.packId) {
    throw new LoadingError({
      code: "cross-check",
      source: packFileName,
      path: "packId",
      message: `内容包 ID「${pack.packId}」与目录「${sources.packId}」不一致`,
    });
  }
  checkDeclaredFiles(pack);

  const lore: ContentLore = parseDocument(contentLoreSchema, requireFile(sources, "lore.yaml"), "lore.yaml");
  const map: ContentMap = parseDocument(contentMapSchema, requireFile(sources, "map.yaml"), "map.yaml");
  const factions: ContentFactions = parseDocument(contentFactionsSchema, requireFile(sources, "factions.yaml"), "factions.yaml");
  const characters: ContentCharacters = parseDocument(
    contentCharactersSchema,
    requireFile(sources, "characters.yaml"),
    "characters.yaml",
  );
  const worldInit: ContentWorldInit = parseDocument(
    contentWorldInitSchema,
    requireFile(sources, "world-init.yaml"),
    "world-init.yaml",
  );
  const rules: ContentRules = parseDocument(contentRulesSchema, requireFile(sources, "rules.yaml"), "rules.yaml");
  const evidence: ContentEvidence = parseDocument(
    contentEvidenceSchema,
    requireFile(sources, "evidence.yaml"),
    "evidence.yaml",
  );
  const starts: ContentStarts = parseDocument(contentStartsSchema, requireFile(sources, "starts.yaml"), "starts.yaml");
  const prompts: ContentPrompts = parseDocument(
    contentPromptsSchema,
    requireFile(sources, "prompts/zh-CN.yaml"),
    "prompts/zh-CN.yaml",
  );
  const locale: ContentLocale = parseDocument(
    contentLocaleSchema,
    requireFile(sources, "locale/zh-CN.yaml"),
    "locale/zh-CN.yaml",
  );

  const scenarios = new Map<string, ContentScenario>();
  for (const relPath of pack.scenarios) {
    scenarios.set(relPath, parseDocument(contentScenarioSchema, requireFile(sources, relPath), relPath));
  }
  const scripts = new Map<string, ContentScript>();
  for (const relPath of pack.scripts) {
    scripts.set(relPath, parseDocument(contentScriptSchema, requireFile(sources, relPath), relPath));
  }

  const parts: ContentParts = {
    pack,
    lore,
    map,
    factions,
    characters,
    worldInit,
    rules,
    evidence,
    starts,
    scenarios,
    scripts,
    prompts,
    locale,
  };
  return { ...parts, index: buildContentIndex(parts) };
}

/** 从内容根目录加载指定内容包；启动失败时不返回部分结果。 */
export function loadContentPack(contentRoot: string, packId: string): ContentPack {
  return parseContentPack(readContentPackSources(contentRoot, packId));
}
