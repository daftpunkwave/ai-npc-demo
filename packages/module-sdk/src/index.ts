/**
 * 汇总服务端模块作者辅助：描述符校验、scoped storage、事务内受控端口、scoped 模型句柄类型与观测数据源端口类型。
 * 依赖本包 define-module 与 ports 的实现及公共契约类型，不加载任何模块实现或宿主资源。
 * 禁止在此创建存储/网络连接、注册全局单例或提供万能执行入口。
 */
export const packageName = "@world-prism/module-sdk";

export { defineModule } from "./define-module";
// 描述符校验已下沉到 kernel，供浏览器与服务端共用；module-sdk 保留原导出，模块作者无需改动导入路径。
export { REALM_NAMESPACES, validateModuleDefinition } from "@world-prism/kernel";
export { createStatelessModule } from "./lifecycle";

export { createScopedStateKey } from "./ports";
export { isApprovedSpeechUsable } from "./speech-approval";
export type {
  AccessAction,
  AccessDecision,
  AccessDecisionReason,
  AccessPolicy,
  AccessRequest,
} from "./access-policy";
export type {
  AggregateEntry,
  AggregateListOptions,
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
export * from "./resource-math";
export * from "./principal-audience";
export * from "./content-view";
export * from "./meters-view";
export * from "./game-route";
export * from "./contributor";
export * from "./agent-ports";
export * from "./model-ports";
export * from "./model-transport";
export * from "./artifact-store";
export * from "./lifecycle-audit";
export * from "./observability-sources";
