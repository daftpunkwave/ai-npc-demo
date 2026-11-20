/**
 * 汇总等距投影模块、公开端口与纯函数。
 * 不读取世界权威或维持浏览器全局状态。
 */
export const packageName = "@ai-npc/mod-client-screen-projection-isometric";
export { projectionModuleDefinition } from "./definition";
export { screenToWorld, tileHeight, tileWidth, worldToScreen } from "./plugin";
export type { ScreenPoint, ScreenProjectionPort } from "./plugin";
