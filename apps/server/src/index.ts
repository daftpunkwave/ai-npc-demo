/**
 * 汇总服务端 HTTP/WS 应用工厂；bootstrap 与 module-catalog 在后续宿主步骤接线。
 * 只导出 createServerApp 与依赖类型。
 */
export { createServerApp } from "./app";
export type { ServerAppOptions, ServerIdentity } from "./app";
export { buildPlayerProjection } from "./projection";
