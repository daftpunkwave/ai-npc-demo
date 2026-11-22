/**
 * 导出结构化记忆账本模块的稳定公开入口。
 * 只暴露描述符数据，不加载实现状态。
 * 禁止创建存储或平行的记忆宿主。
 */
export { memoryLedgerModuleDefinition } from "./definition";
export type { LedgerConfig } from "./definition";
