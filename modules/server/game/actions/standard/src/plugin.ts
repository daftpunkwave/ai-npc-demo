/**
 * 创建标准行动模块实例；没有后台任务，端口由宿主按事务绑定。
 * 依赖无状态生命周期骨架与端口工厂。
 * 禁止在 create 阶段读取内容、创建任务或启动风险抽样。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { createActionsPort } from "./port";

/** 行动模块实例暴露端口绑定器。 */
export function createActionsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, { bind: createActionsPort });
}
