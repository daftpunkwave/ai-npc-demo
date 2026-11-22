/**
 * 核心职责：公开公平调度模块定义与配置 schema。
 * 交互契约：只导出模块定义、配置 schema 与公开类型。
 * 约束与禁忌：不加载模块实例。
 */
export const packageName = "@ai-npc/mod-agent-scheduling-fair";
export { schedulingConfigSchema, schedulingModuleDefinition } from "./definition";
