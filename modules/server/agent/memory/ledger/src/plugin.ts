/**
 * 使用已校验配置创建结构化账本记忆策略。
 * 依赖 MemoryPort 与模块生命周期辅助。
 * 禁止直接访问 SQLite 或模型传输层。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
import { ledgerConfigSchema } from "./definition";
import { createLedgerPort } from "./ledger-port";

export function createLedgerMemoryModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = ledgerConfigSchema.parse(input.config);
  return createStatelessModule(input, createLedgerPort(config, input.host.ids));
}
