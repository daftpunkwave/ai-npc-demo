/**
 * 定义已校验内容包的公共形状：各内容文件解析结果、按固定 ID 建立的只读索引与两者的组合。
 * 依赖本包各内容文件 schema 推导出的类型；内容加载器产出该形状，运行时与游戏模块只按它读取。
 * 禁止在此读取文件、构建索引或执行交叉检查；新增内容字段只改对应文件的 schema。
 */
import type {
  ContentCharacter,
  ContentCharacters,
  ContentFaction,
  ContentFactions,
  ContentLore,
  ContentMap,
  ContentNode,
  ContentPackFile,
  ContentRoad,
} from "./content-world";
import type {
  ContentCard,
  ContentEvidence,
  ContentEvidenceEntry,
  ContentGroup,
  ContentRules,
  ContentScenario,
  ContentScript,
  ContentSecret,
  ContentStart,
  ContentStarts,
  ContentStockpile,
  ContentTeam,
  ContentWorldInit,
} from "./content-state";
import type { ContentLocale, ContentPrompts } from "./content-templates";

/** 内容包全部文件解析后的部分；scenarios 与 scripts 以包内相对路径为键。 */
export interface ContentParts {
  readonly pack: ContentPackFile;
  readonly lore: ContentLore;
  readonly map: ContentMap;
  readonly factions: ContentFactions;
  readonly characters: ContentCharacters;
  readonly worldInit: ContentWorldInit;
  readonly rules: ContentRules;
  readonly evidence: ContentEvidence;
  readonly starts: ContentStarts;
  readonly scenarios: ReadonlyMap<string, ContentScenario>;
  readonly scripts: ReadonlyMap<string, ContentScript>;
  readonly prompts: ContentPrompts;
  readonly locale: ContentLocale;
}

/** 内容包索引：固定 ID 到内容的只读映射与主体集合。 */
export interface ContentIndex {
  readonly nodes: ReadonlyMap<string, ContentNode>;
  readonly roads: ReadonlyMap<string, ContentRoad>;
  readonly factions: ReadonlyMap<string, ContentFaction>;
  readonly characters: ReadonlyMap<string, ContentCharacter>;
  readonly stockpiles: ReadonlyMap<string, ContentStockpile>;
  readonly teams: ReadonlyMap<string, ContentTeam>;
  readonly groups: ReadonlyMap<string, ContentGroup>;
  readonly evidence: ReadonlyMap<string, ContentEvidenceEntry>;
  readonly secrets: ReadonlyMap<string, ContentSecret>;
  readonly starts: ReadonlyMap<string, ContentStart>;
  readonly cards: ReadonlyMap<string, ContentCard>;
  readonly scenarios: ReadonlyMap<string, ContentScenario>;
  readonly scripts: ReadonlyMap<string, ContentScript>;
  readonly principalIds: ReadonlySet<string>;
  readonly agentIds: ReadonlySet<string>;
  readonly characterIds: ReadonlySet<string>;
  readonly factionIds: ReadonlySet<string>;
  readonly evidenceIds: ReadonlySet<string>;
  readonly secretIds: ReadonlySet<string>;
  readonly playerPrincipalId: string;
}

/** 解析并交叉检查后的内容包；索引供运行时按 ID 查询。 */
export interface ContentPack extends ContentParts {
  readonly index: ContentIndex;
}
