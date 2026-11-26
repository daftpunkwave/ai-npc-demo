/**
 * 核心职责：汇总客户端选择模块定义与公开端口。
 * 交互契约：只导出输入模块定义与公开类型。
 * 约束与禁忌：不创建 DOM 事件或服务端命令连接。
 */
export const packageName = "@world-prism/mod-client-input-standard";
export { inputModuleDefinition } from "./definition";
export type { Selection, SelectionPort } from "./plugin";
