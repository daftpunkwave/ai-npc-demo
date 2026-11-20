/**
 * 汇总 SQLite 观测模块定义、查询端口与时间线输入类型。
 * 不打开数据库或启动后台采样器。
 */
export const packageName = "@ai-npc/mod-platform-observability-sqlite";
export { observabilityModuleDefinition } from "./definition";
export { ObservabilityPort } from "./plugin";
export type { SpanRecord, TimelineQuery } from "./plugin";
