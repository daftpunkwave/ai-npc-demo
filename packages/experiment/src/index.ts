/**
 * 汇总 experiment 包的公开入口：从磁盘与草稿加载并交叉检查内容包、名册、RunSpec、profile、
 * toolset、模型布局与实验规格，返回公共契约定义的已校验形状。
 * 依赖加载器与本包私有的配置文档 schema；内容包、名册与已解析 profile 的类型由公共契约包提供，调用方从那里引用。
 * 禁止在此创建 run、分支或 manifest，也不得启动运行时、读取默认环境变量或隐藏加载失败。
 */
export const packageName = "@world-prism/experiment";
export * from "./config/model-layout";

export {
  loadContentPack,
  parseContentPack,
  readContentPackSources,
} from "./content/load-content-pack";
export type { ContentPackSources } from "./content/load-content-pack";
export {
  loadConfigDocument,
  loadRoster,
  loadRunSpec,
  resolveConfigReference,
  validateRoster,
  validateRunSpec,
} from "./config/load-config";
export { createConfigDocumentCache } from "./config/config-document-cache";
export type { ConfigDocumentCache } from "./config/config-document-cache";
export type {
  ConfigDraftKind,
  ConfigDraftReader,
  ConfigLoadContext,
  LoadedConfig,
  ResolvedConfigReference,
  RunSpecOverrides,
} from "./config/load-config";
export { runSpecSchema } from "./config/schema";
export type { RunSpec } from "./config/schema";
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
export type { AgentProfileDocument } from "./config/agent-profile";
export { LoadingError, formatIssuePath, schemaLoadingError } from "./loading/errors";
export type { LoadingErrorCode } from "./loading/errors";
