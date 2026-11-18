/**
 * 创建世界模块实例；campaign 与规则状态都在 authority 事务内写入。
 * 依赖无状态生命周期骨架、端口工厂与模块创建输入。
 * 禁止在 create 阶段读取内容、时钟或初始化 campaign。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { createWorldPort } from "./port";

/** 世界实现没有后台任务，暴露端口绑定器供宿主装配。 */
export function createWorldModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, { bind: createWorldPort });
}
