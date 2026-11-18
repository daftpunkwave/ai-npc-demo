/**
 * 创建剧情模块实例；升级版通过布尔参数选择节奏策略。
 * 依赖无状态生命周期骨架与处理器工厂。
 * 禁止在 create 阶段读取内容、触发卡片或启动订阅。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { createScenarioContributor } from "./contributor";
import { createScenarioPort } from "./port";

/** 创建剧情模块；escalating 只影响节奏与 DayPassed 压力。 */
export function createScenarioModule(input: ModuleCreateInput, escalating: boolean): Promise<ModuleInstance> {
  const contributor = createScenarioContributor({ escalating });
  return createStatelessModule(input, {
    bind: (txFor: Parameters<typeof createScenarioPort>[0]) => ({
      ...createScenarioPort(txFor, input.moduleId),
      contributor,
    }),
  });
}
