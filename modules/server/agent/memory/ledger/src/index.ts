/**
 * 导出结构化记忆账本模块的稳定公开入口。
 * Public entry for the structured-ledger memory module.
 * Exposes descriptor data without loading implementation state.
 * Must not create storage or a parallel memory host.
 */
export const packageName = "@ai-npc/mod-agent-memory-ledger";

export { ledgerConfigSchema, memoryLedgerModuleDefinition } from "./definition";
export type { LedgerConfig } from "./definition";
