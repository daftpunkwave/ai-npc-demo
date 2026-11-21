/**
 * 汇总玩家授权投影模块的定义与公开端口。
 * 不创建网络连接或浏览器全局状态。
 */
export const packageName = "@ai-npc/mod-client-world-view-standard";
export { worldViewModuleDefinition } from "./definition";
export type { WorldViewConnectionState, WorldViewPort } from "./plugin";
