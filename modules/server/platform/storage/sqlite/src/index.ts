/**
 * 汇总 platform.storage.sqlite 的公开入口：模块定义、配置 schema 与配置类型。
 * 依赖 definition 与公共契约类型；不加载 SQLite 实现，也不创建连接。
 * 禁止在此暴露内部实现、数据库句柄或绕过 definition 的注册入口。
 */
export const packageName = "@ai-npc/mod-platform-storage-sqlite";

export { storageConfigSchema, storageModuleDefinition } from "./definition";
export type { StorageConfig } from "./definition";
