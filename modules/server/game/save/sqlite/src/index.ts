/**
 * 公开存档模块入口：模块定义与模块工厂；端口契约由 module-sdk 的 SavePort 声明。
 * 只导出装配需要的符号，不导出具体实现类。
 * 禁止在这里执行存储或分支操作。
 */
export const packageName = "@world-prism/mod-game-save-sqlite";

export { saveModuleDefinition } from "./definition";
export { createSaveModule } from "./plugin";
