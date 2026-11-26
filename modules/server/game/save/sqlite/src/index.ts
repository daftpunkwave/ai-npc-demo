/**
 * 公开存档模块入口：定义、服务类型与服务实现。
 * 只导出装配与调用方需要的符号。
 * 禁止在这里执行存储或分支操作。
 */
export const packageName = "@world-prism/mod-game-save-sqlite";

export { saveModuleDefinition } from "./definition";
export { createSaveModule } from "./plugin";
export { SqliteSaveService } from "./service";
export type { CreateSnapshotInput, RestoreSnapshotInput, SaveService, SnapshotRecord } from "./service";
