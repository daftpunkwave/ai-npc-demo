/**
 * 创建标准通信模块实例；没有后台任务，端口由宿主按事务绑定。
 * 依赖无状态生命周期骨架、规则贡献与端口工厂。
 * 禁止在 create 阶段读取内容、生成会话或发送消息。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { createCommsContributor } from "./contributor";
import { createCommsPort } from "./port";

/** 通信模块实例的公开端口同时暴露事务绑定器与规则贡献。 */
export function createCommsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, {
    bind: createCommsPort,
    contributor: createCommsContributor(),
  });
}
