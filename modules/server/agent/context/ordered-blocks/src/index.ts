/**
 * 核心职责：公开有序上下文模块的定义与配置 schema。
 * 交互契约：调用方仅通过模块公开入口读取描述符，不加载实现实例。
 * 约束与禁忌：不得在此持有 Agent 状态或创建第二套上下文管线。
 */
export const packageName = "@ai-npc/mod-agent-context-ordered-blocks";
export { orderedBlocksContextConfigSchema, orderedBlocksContextDefinition } from "./definition";
