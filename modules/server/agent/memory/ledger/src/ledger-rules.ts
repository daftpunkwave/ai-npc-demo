/**
 * 汇总账本摄入、引用强化与容量处理的稳定内部入口。
 * Re-exports deterministic ledger row builders for the module orchestration layer.
 * Must not contain policy logic or storage access.
 */
export type { LedgerBuild } from "./ledger-model";
export { buildIngestion } from "./ledger-ingest";
export { applyUsage, capacityRetirements } from "./ledger-usage";
