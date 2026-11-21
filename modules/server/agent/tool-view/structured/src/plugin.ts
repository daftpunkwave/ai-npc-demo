/**
 * 核心职责：构造结构化工具视图模块并暴露 agent.tool-view 端口。
 * 交互契约：配置在模块创建时校验，视图转换不访问外部资源。
 * 约束与禁忌：不得缓存原始结果或改变执行事实。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import type { AgentToolViewPort } from "@ai-npc/module-sdk";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { structuredToolViewConfigSchema, type StructuredToolViewConfig } from "./definition";
import { renderStructuredView } from "./structured-view";

class StructuredToolViewPort implements AgentToolViewPort {
  constructor(private readonly config: StructuredToolViewConfig) {}

  render(input: Parameters<AgentToolViewPort["render"]>[0]): ReturnType<AgentToolViewPort["render"]> {
    return renderStructuredView(input, this.config);
  }
}

export function createStructuredToolViewModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = structuredToolViewConfigSchema.parse(input.config);
  return createStatelessModule(input, new StructuredToolViewPort(config));
}