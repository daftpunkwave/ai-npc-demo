/**
 * 汇总 experiment 包的公开入口：内容包与配置加载、索引、交叉检查。
 * 依赖加载器、schema 与内容索引；调用方只经此处访问，不导入内部文件。
 * 禁止在此启动运行时、读取默认环境变量或隐藏加载失败。
 */
export const packageName = "@ai-npc/experiment";
export * from "./config/model-layout";

export {
  loadContentPack,
  parseContentPack,
  readContentPackSources,
} from "./content/load-content-pack";
export type { ContentPack, ContentPackSources } from "./content/load-content-pack";
export type { ContentIndex } from "./content/content-index";
export type {
  ContentCard,
  ContentCharacter,
  ContentEvidenceEntry,
  ContentFaction,
  ContentGroup,
  ContentLocale,
  ContentLore,
  ContentMap,
  ContentNode,
  ContentPrompts,
  ContentRoad,
  ContentScenario,
  ContentScript,
  ContentScriptStep,
  ContentSecret,
  ContentStart,
  ContentStockpile,
  ContentTeam,
  ContentWorldInit,
} from "./content/schema/index";
export {
  loadConfigDocument,
  loadRoster,
  loadRunSpec,
  resolveConfigReference,
  validateRoster,
  validateRunSpec,
} from "./config/load-config";
export type {
  ConfigDraftKind,
  ConfigDraftReader,
  ConfigLoadContext,
  LoadedConfig,
  ResolvedConfigReference,
  RunSpecOverrides,
} from "./config/load-config";
export { configRefSchema, rosterSchema, runSpecSchema } from "./config/schema";
export type { Roster, RunSpec } from "./config/schema";
export {
  experimentRunSpecTemplateSchema,
  experimentSpecSchema,
  expandExperimentRuns,
} from "./config/experiment-spec";
export type { ExpandedRun, ExperimentRunSpecTemplate, ExperimentSpec } from "./config/experiment-spec";
export { loadExperimentSpec, validateExperimentSpec } from "./config/load-experiment-spec";
export { loadAgentToolset, type AgentToolset } from "./config/toolset";
export {
  applyProfilePatch,
  loadAgentProfile,
  profileJson,
  validateProfileSelection,
} from "./config/agent-profile";
export type {
  AgentModuleSelection,
  AgentProfileDocument,
  ResolvedAgentProfile,
} from "./config/agent-profile";
export { LoadingError, formatIssuePath, schemaLoadingError } from "./loading/errors";
export type { LoadingErrorCode } from "./loading/errors";
