/**
 * 汇总客户端选择模块定义与公开端口。
 * 不创建 DOM 事件或服务端命令连接。
 */
export const packageName = "@ai-npc/mod-client-input-standard";
export { inputModuleDefinition } from "./definition";
export type { Selection, SelectionPort } from "./plugin";
