/**
 * 汇总运营编排模块的公开入口：定义、配置 schema、服务与驱动类型。
 * 不打开存储、不启动 worker。
 */
export const packageName = "@ai-npc/mod-platform-operations-standard";

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
