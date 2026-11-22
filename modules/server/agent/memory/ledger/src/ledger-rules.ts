/**
 * 汇总账本摄入、引用强化与容量处理的稳定内部入口。
 * 供模块编排层复用确定性的账本行构造器。
 * 禁止包含策略逻辑或存储访问。
 */
export type { LedgerBuild } from "./ledger-model";
export { buildIngestion } from "./ledger-ingest";
export { applyUsage, capacityRetirements } from "./ledger-usage";
