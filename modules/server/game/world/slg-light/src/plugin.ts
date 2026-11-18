/**
 * 创建世界模块实例；campaign 与规则状态都在 authority 事务内写入。
 * 依赖公共契约的模块实例类型；配置已由宿主校验。
 * 禁止在 create 阶段读取内容、时钟或初始化 campaign。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createWorldPort } from "./port";

/** 世界实现没有后台任务，暴露端口绑定器供宿主装配。 */
export function createWorldModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return Promise.resolve({
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
    port: { bind: createWorldPort },
  });
}
