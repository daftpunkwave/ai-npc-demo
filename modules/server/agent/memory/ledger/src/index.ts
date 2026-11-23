/**
 * 导出结构化账本与两种记忆对比策略的稳定公开入口。
 * 只暴露描述符数据，不加载实现状态。
 * 禁止创建存储或平行的记忆宿主。
 */
export {
  memoryLayeredHybridModuleDefinition,
  memoryLedgerModuleDefinition,
  memoryStreamReflectionModuleDefinition,
} from "./definition";
export type { LedgerConfig, LayeredHybridConfig, StreamReflectionConfig } from "./definition";