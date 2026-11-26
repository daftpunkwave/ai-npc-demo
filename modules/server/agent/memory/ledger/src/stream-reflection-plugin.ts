/**
 * 核心职责：创建观察流反思记忆模块的无状态端口实例。
 * 交互契约：依赖已校验配置、模块生命周期辅助与注入 ID 服务。
 * 约束与禁忌：禁止直接访问 SQLite、模型传输层或跨 Agent 状态。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
import { streamReflectionConfigSchema } from "./definition";
import { createStreamReflectionPort } from "./stream-reflection-port";

export function createStreamReflectionMemoryModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = streamReflectionConfigSchema.parse(input.config);
  return createStatelessModule(input, createStreamReflectionPort(config, input.host.ids));
}