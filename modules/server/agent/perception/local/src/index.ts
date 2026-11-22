/**
 * 核心职责：公开本地感知模块定义与配置 schema。
 * 交互契约：只导出模块定义、配置 schema 与公开类型。
 * 约束与禁忌：不加载具体实例或世界状态。
 */
export const packageName = "@ai-npc/mod-agent-perception-local";
export { perceptionConfigSchema, perceptionModuleDefinition } from "./definition";
