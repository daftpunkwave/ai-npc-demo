/**
 * 核心职责：汇总运营编排模块的公开入口。
 * 交互契约：只导出定义、配置 schema、服务与驱动类型。
 * 约束与禁忌：不打开存储、不启动 worker。
 */
export const packageName = "@world-prism/mod-platform-operations-standard";

export { operationsConfigSchema, operationsModuleDefinition } from "./definition";
export type { OperationsConfig } from "./definition";
export { OperationsService } from "./plugin";
export type {
  IdempotentOperationsDriver,
  OperationRequest,
  OperationsDriver,
  RestoreInput,
  RestoreOutcome,
  SnapshotInput,
  SnapshotView,
} from "./plugin";
