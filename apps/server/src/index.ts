/**
 * 汇总服务端宿主公开入口；传输应用由 transport provider 提供。
 * 不启动服务、不打开存储。
 */
export { createServerApp } from "./host/module-catalog";
export type { AuthorityPort, ServerApp, ServerAppOptions, ServerIdentity } from "./host/module-catalog";
export { buildPlayerProjection } from "./projection";
export { startHost } from "./host";
export type { HostOptions, RunningHost } from "./host";
export { serverModuleDefinitions } from "./host/module-catalog";
