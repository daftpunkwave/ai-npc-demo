/**
 * 核心职责：汇总模块管理工作台定义与只读端口。
 * 交互契约：只导出模块定义、只读端口与公开类型。
 * 约束与禁忌：不扫描文件系统、启动模块或写入装配草稿。
 */
export const packageName = "@world-prism/mod-platform-module-admin-standard";
export { moduleAdminModuleDefinition } from "./definition";
export { ModuleAdminPort } from "./plugin";
export type { AdminAssembly, ModuleAdminSnapshot } from "./plugin";
