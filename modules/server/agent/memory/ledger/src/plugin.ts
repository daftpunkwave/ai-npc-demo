/**
 * 使用已校验配置创建结构化账本记忆策略。
 * Creates the ledger memory policy with its parsed strict configuration.
 * Depends on MemoryPort and the module lifecycle helper.
 * Must not access SQLite or model transports directly.
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { ledgerConfigSchema } from "./definition";
import { createLedgerPort } from "./ledger-port";

export function createLedgerMemoryModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = ledgerConfigSchema.parse(input.config);
  return createStatelessModule(input, createLedgerPort(config, input.host.ids));
}
