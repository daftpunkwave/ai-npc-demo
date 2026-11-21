/**
 * 核心职责：构造无状态窗口压缩模块并暴露 agent.compression 端口。
 * 交互契约：配置在创建时校验，每次压缩只读取指定 artifact。
 * 约束与禁忌：不得缓存上下文或改写已发送 artifact。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import type { AgentCompressionPort } from "@ai-npc/module-sdk";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { windowCompressionConfigSchema, type WindowCompressionConfig } from "./definition";
import { compressWindow } from "./window-compression";

class WindowCompressionPort implements AgentCompressionPort {
  constructor(private readonly config: WindowCompressionConfig) {}

  compress(input: Parameters<AgentCompressionPort["compress"]>[0]): ReturnType<AgentCompressionPort["compress"]> {
    return compressWindow(input.artifact, input.effectiveMaxTokens, input.targetTokens, this.config);
  }
}

export function createCompressionWindowModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = windowCompressionConfigSchema.parse(input.config);
  return createStatelessModule(input, new WindowCompressionPort(config));
}