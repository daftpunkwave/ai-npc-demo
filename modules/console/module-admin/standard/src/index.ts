/**
 * 核心职责：汇总模块管理页面定义。
 * 交互契约：只导出页面定义与公开类型，不携带模块实例。
 * 约束与禁忌：不读取本地配置或执行装配预检。
 */
export const packageName = "@ai-npc/mod-console-module-admin-standard";
export { moduleAdminPageModuleDefinition } from "./definition";
