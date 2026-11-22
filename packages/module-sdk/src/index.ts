/**
 * 汇总服务端模块作者辅助：描述符校验、scoped storage、事务内受控端口与 scoped 模型句柄类型。
 * 依赖本包 define-module 与 ports 的实现及公共契约类型，不加载任何模块实现或宿主资源。
 * 禁止在此创建存储/网络连接、注册全局单例或提供万能执行入口。
 */
export const packageName = "@ai-npc/module-sdk";

export { defineModule } from "./define-module";
export { validateModuleDefinition } from "./descriptor-validation";
export { REALM_NAMESPACES } from "./descriptor-constraints";
export { createStatelessModule } from "./lifecycle";

export { createScopedStateKey } from "./ports";
export { isApprovedSpeechUsable } from "./speech-approval";
export type {
  AggregateEntry,
  AggregateRecord,
  ApprovedSpeech,
  ApprovedSpeechReader,
  HandlerContext,
  HandlerResult,
  ModuleBinder,
  OpResult,
  ScopedModelPort,
  ScopedModelScope,
  ScopedStateKey,
  ScopedStoragePort,
  ScopedStorageRecord,
  ScopedWorldTxFactory,
  WorldTx,
  WorldTxReader,
} from "./ports";
export * from "./game-ports";
export * from "./game-utils";
export * from "./game-route";
export * from "./contributor";
export * from "./agent-ports";
export * from "./model-ports";
export * from "./model-transport";
export * from "./artifact-store";
