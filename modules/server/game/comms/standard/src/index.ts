/**
 * 汇总标准通信模块的公开入口：模块定义、端口工厂与规则贡献。
 * 依赖定义、端口与处理器文件；宿主只经组合根登记定义。
 * 禁止在这里打开存储、生成会话或加入未登记的事件类型。
 */
export const packageName = "@world-prism/mod-game-comms-standard";

export { commsModuleDefinition } from "./definition";
export { createCommsContributor } from "./contributor";
export { probeAsk } from "./probe";
export { createCommsPort } from "./port";
export type { CommsReasonCode } from "./port";
export { conversationStateSchema, knowledgeGrantStateSchema, readCommsState } from "./state";
export type { ConversationState, KnowledgeGrantState } from "./state";
