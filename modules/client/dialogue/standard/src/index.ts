/**
 * 核心职责：汇总标准对话模块定义。
 * 交互契约：只导出对话模块定义与公开端口。
 * 约束与禁忌：不读取模型调用或创建网络连接。
 */
export const packageName = "@ai-npc/mod-client-dialogue-standard";
export { dialogueModuleDefinition } from "./definition";
