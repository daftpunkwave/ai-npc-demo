/**
 * 核心职责：汇总开局选择模块定义。
 * 交互契约：只导出 packageName 与 factionStartModuleDefinition。
 * 约束与禁忌：不创建世界或连接服务端存储。
 */
export const packageName = "@ai-npc/mod-client-faction-start-standard";
export { factionStartModuleDefinition } from "./definition";
