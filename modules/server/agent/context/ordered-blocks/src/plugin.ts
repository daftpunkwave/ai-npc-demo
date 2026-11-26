/**
 * 核心职责：构造有序上下文模块实例并暴露 AgentContextPort。
 * 交互契约：配置在模块创建时完成严格校验，artifact 由 builder 纯计算生成。
 * 约束与禁忌：不得持有跨 turn 的可变上下文或启动后台任务。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
import { orderedBlocksContextConfigSchema } from "./definition";
import { OrderedBlocksContextBuilder } from "./context-builder";

export function createOrderedBlocksContextModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = orderedBlocksContextConfigSchema.parse(input.config);
  return createStatelessModule(input, new OrderedBlocksContextBuilder(config, input.host));
}