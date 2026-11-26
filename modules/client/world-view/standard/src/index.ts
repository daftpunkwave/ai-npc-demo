/**
 * 核心职责：汇总玩家授权投影模块的定义与公开端口。
 * 交互契约：只导出投影模块定义、连接策略与公开类型。
 * 约束与禁忌：不创建网络连接或浏览器全局状态。
 */
export const packageName = "@world-prism/mod-client-world-view-standard";
export { worldViewModuleDefinition } from "./definition";
export type { WorldViewConnectionState, WorldViewPort } from "./plugin";
