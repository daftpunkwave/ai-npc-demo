/**
 * 解析配置文件引用、替换 env: 值并用 zod schema 校验名册与 RunSpec。
 * 依赖文件系统、yaml、配置 schema 与可选的草稿读取器；仓库 config/ 优先于数据库草稿。
 * 禁止把草稿当成已生效配置、跳过 schema 校验或在引用歧义时静默选择文件。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { z } from "zod";
import type { ContentPack } from "../content/load-content-pack";
import { LoadingError, schemaLoadingError } from "../loading/errors";
import { parseYamlText } from "../loading/yaml";
import { configRefSchema, rosterSchema, type Roster, runSpecSchema, type RunSpec } from "./schema";

/** 可保存为数据库草稿的配置种类；与 config_drafts 的 kind 约束一致。 */
export type ConfigDraftKind = "assembly" | "model-layout" | "profile" | "toolset";

/** 数据库草稿读取器：返回最新版本的 JSON 值，没有草稿时返回 null。 */
export interface ConfigDraftReader {
  // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars -- 参数名只用于表达读取契约。
  read: (kind: ConfigDraftKind, configId: string) => unknown;
}

/** 配置加载上下文：仓库配置目录、环境变量与可选的草稿来源。 */
export interface ConfigLoadContext {
  readonly configDir: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly drafts?: ConfigDraftReader;
}

/** 已解析的配置引用：仓库文件或草稿。 */
export type ResolvedConfigReference =
  | { readonly kind: "file"; readonly path: string; readonly text: string }
  | { readonly kind: "draft"; readonly configRef: string; readonly value: unknown };

/** 加载结果：保留引用与来源，便于观测与冻结 manifest。 */
export interface LoadedConfig<T> {
  readonly configRef: string;
  readonly source: string;
  readonly value: T;
}

/** 递归列出目录下的 YAML 文件；跳过符号链接目录，避免扫描环路。 */
function listYamlFiles(dir: string): string[] {
  const files: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 只扫描宿主注入的本地 config/ 目录。
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listYamlFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 在 config/ 下按文件基名查找引用；多个同名文件视为配置歧义。 */
function findRepoConfigFile(configRef: string, configDir: string): string | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- configDir 由宿主注入且只指向本地 config/。
  if (!existsSync(configDir)) {
    return null;
  }
  const matches = listYamlFiles(configDir).filter((file) => {
    const name = basename(file);
    const base = name.endsWith(".yaml") ? name.slice(0, -".yaml".length) : name.slice(0, -".yml".length);
    return base === configRef;
  });
  if (matches.length > 1) {
    throw new LoadingError({
      code: "reference",
      source: configRef,
      message: `存在多个同名配置文件：${matches.join("、")}`,
    });
  }
  return matches[0] ?? null;
}

/** 校验引用形态，拒绝路径穿越与绝对路径。 */
function assertConfigRef(configRef: string): void {
  const result = configRefSchema.safeParse(configRef);
  if (!result.success) {
    throw new LoadingError({ code: "reference", source: configRef, message: "配置引用不合法" });
  }
}

/**
 * 按“仓库文件优先、草稿其次”的规则解析一个配置引用。
 * 草稿只对装配、模型布局、profile 与 toolset 开放；其他引用查不到即失败。
 */
export function resolveConfigReference(
  configRef: string,
  context: ConfigLoadContext,
  draftKind?: ConfigDraftKind,
): ResolvedConfigReference {
  assertConfigRef(configRef);
  const file = findRepoConfigFile(configRef, context.configDir);
  if (file !== null) {
    let text: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 路径来自 config/ 的基名匹配结果。
      text = readFileSync(file, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LoadingError({ code: "reference", source: file, message });
    }
    return { kind: "file", path: file, text };
  }
  if (draftKind !== undefined && context.drafts !== undefined) {
    const value = context.drafts.read(draftKind, configRef);
    if (value !== null && value !== undefined) {
      return { kind: "draft", configRef, value };
    }
  }
  throw new LoadingError({
    code: "reference",
    source: configRef,
    message: draftKind === undefined ? "在 config/ 中找不到配置" : "在 config/ 与数据库草稿中都找不到配置",
  });
}

/** env:NAME 形式的引用；NAME 必须是合法的环境变量名。 */
const envReferencePattern = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/** 深度替换 env: 引用；缺失或空值都按预检失败处理。 */
function resolveEnvValue(
  value: unknown,
  path: readonly string[],
  source: string,
  env: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    const match = envReferencePattern.exec(value);
    if (match === null) {
      return value;
    }
    const [, name = ""] = match;
    const resolved = env.get(name);
    if (resolved === undefined || resolved === "") {
      throw new LoadingError({
        code: "env",
        source,
        path: path.join("."),
        message: `环境变量「${name}」未设置或为空`,
      });
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveEnvValue(item, [...path, String(index)], source, env));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveEnvValue(item, [...path, key], source, env),
      ]),
    );
  }
  return value;
}

/** 把注入的环境变量记录转换为只读映射，空值保留由解析阶段拒绝。 */
function environmentMap(env: Readonly<Record<string, string | undefined>>): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      map.set(name, value);
    }
  }
  return map;
}

/** 读取、解析、替换 env: 并校验任意配置文档。 */
export function loadConfigDocument<T>(
  configRef: string,
  schema: z.ZodType<T>,
  context: ConfigLoadContext,
  draftKind?: ConfigDraftKind,
): LoadedConfig<T> {
  const reference = resolveConfigReference(configRef, context, draftKind);
  const source = reference.kind === "file" ? reference.path : `draft:${draftKind ?? "unknown"}:${configRef}`;
  const raw = reference.kind === "file" ? parseYamlText(reference.text, source) : reference.value;
  const resolved = resolveEnvValue(raw, [], source, environmentMap(context.env ?? {}));
  const result = schema.safeParse(resolved);
  if (!result.success) {
    throw schemaLoadingError(source, result.error);
  }
  return { configRef, source, value: result.data };
}

/** 加载名册；文档 ID 必须与引用一致，内容身份检查由 validateRoster 负责。 */
export function loadRoster(configRef: string, context: ConfigLoadContext): LoadedConfig<Roster> {
  const loaded = loadConfigDocument(configRef, rosterSchema, context);
  if (loaded.value.rosterId !== configRef) {
    throw new LoadingError({
      code: "reference",
      source: loaded.source,
      path: "rosterId",
      message: `名册 ID「${loaded.value.rosterId}」与引用「${configRef}」不一致`,
    });
  }
  return loaded;
}

/** 加载 RunSpec；文档 ID 必须与引用一致，引用存在性由 validateRunSpec 负责。 */
export function loadRunSpec(configRef: string, context: ConfigLoadContext): LoadedConfig<RunSpec> {
  const loaded = loadConfigDocument(configRef, runSpecSchema, context);
  if (loaded.value.id !== configRef) {
    throw new LoadingError({
      code: "reference",
      source: loaded.source,
      path: "id",
      message: `RunSpec ID「${loaded.value.id}」与引用「${configRef}」不一致`,
    });
  }
  return loaded;
}

/** 校验名册身份存在、类别匹配且不重复。 */
export function validateRoster(roster: Roster, content: ContentPack, source = `roster:${roster.rosterId}`): void {
  const seen = new Set<string>();
  roster.agents.forEach((agent, index) => {
    if (seen.has(agent.agentId)) {
      throw new LoadingError({
        code: "cross-check",
        source,
        path: `agents.${index}.agentId`,
        message: `身份「${agent.agentId}」在名册中重复`,
      });
    }
    seen.add(agent.agentId);
    const faction = content.index.factions.get(agent.agentId);
    const character = content.index.characters.get(agent.agentId);
    if (faction === undefined && character === undefined) {
      throw new LoadingError({
        code: "cross-check",
        source,
        path: `agents.${index}.agentId`,
        message: `身份「${agent.agentId}」不在内容包中`,
      });
    }
    if (faction !== undefined && agent.kind !== "strategic") {
      throw new LoadingError({
        code: "cross-check",
        source,
        path: `agents.${index}.kind`,
        message: `派系「${agent.agentId}」必须以 strategic 身份登记`,
      });
    }
    if (character !== undefined && agent.kind !== "character") {
      throw new LoadingError({
        code: "cross-check",
        source,
        path: `agents.${index}.kind`,
        message: `角色「${agent.agentId}」必须以 character 身份登记`,
      });
    }
  });
}

/** 校验 RunSpec 的内容引用、玩家身份与变体范围；装配与模型布局在拥有配置后再校验。 */
export function validateRunSpec(
  runSpec: RunSpec,
  content: ContentPack,
  roster?: LoadedConfig<Roster>,
  source = `run:${runSpec.id}`,
): void {
  function fail(path: string, message: string): never {
    throw new LoadingError({ code: "cross-check", source, path, message });
  }
  if (runSpec.worldPackRef !== content.pack.packId) {
    fail("worldPackRef", `内容包「${runSpec.worldPackRef}」与已加载内容包「${content.pack.packId}」不一致`);
  }
  if (!content.index.scenarios.has(runSpec.scenarioRef)) {
    fail("scenarioRef", `剧情「${runSpec.scenarioRef}」不存在`);
  }
  if (runSpec.script !== null) {
    const script = content.index.scripts.get(runSpec.script.scriptRef);
    if (script === undefined) {
      fail("script.scriptRef", `脚本「${runSpec.script.scriptRef}」不存在`);
    }
    if (runSpec.script.branch !== undefined) {
      const branchName = runSpec.script.branch;
      if (!script.branches?.some((branch) => branch.name === branchName)) {
        fail("script.branch", `脚本「${script.scriptId}」没有分支「${branchName}」`);
      }
    }
    if (script.rosterRef !== runSpec.rosterRef) {
      fail(
        "rosterRef",
        `脚本「${script.scriptId}」要求名册「${script.rosterRef}」，与 RunSpec 的「${runSpec.rosterRef}」不一致`,
      );
    }
  }
  if (runSpec.player.principalId !== content.index.playerPrincipalId) {
    fail("player.principalId", `玩家主体「${runSpec.player.principalId}」与内容包玩家「${content.index.playerPrincipalId}」不一致`);
  }
  if (runSpec.player.factionId !== null) {
    const faction = content.index.factions.get(runSpec.player.factionId);
    if (faction === undefined) {
      fail("player.factionId", `玩家派系「${runSpec.player.factionId}」不存在`);
    }
    if (faction.kind !== "human") {
      fail("player.factionId", `玩家只能选择人类派系，「${runSpec.player.factionId}」不是人类派系`);
    }
  }
  runSpec.variant?.agentIds?.forEach((agentId, index) => {
    if (!content.index.agentIds.has(agentId)) {
      fail(`variant.agentIds.${index}`, `变体对象「${agentId}」不是内容身份`);
    }
  });
  if (roster !== undefined && runSpec.rosterRef !== roster.value.rosterId) {
    fail("rosterRef", `名册引用「${runSpec.rosterRef}」与已加载名册「${roster.value.rosterId}」不一致`);
  }
}
