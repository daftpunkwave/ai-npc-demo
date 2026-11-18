/**
 * 创建世界模块实例；campaign 与规则状态都在 authority 事务内写入。
 * 依赖公共契约的模块实例类型；配置已由宿主校验。
 * 禁止在 create 阶段读取内容、时钟或初始化 campaign。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";

/** 世界实现没有后台任务，返回空生命周期实例。 */
export async function createWorldModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return {
    moduleId: input.moduleId,
    start: async () => {
      // 世界状态由 campaign.start 与后续规则处理器创建。
    },
    drain: async () => {
      // 没有在途写入。
    },
    dispose: async () => {
      // 没有连接或定时器。
    },
  };
}
