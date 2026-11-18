/**
 * 创建轻资源模块实例；库存写入只发生在规则事务内，模块本身不持有连接。
 * 依赖公共契约的模块实例类型；配置已由宿主校验。
 * 禁止在 create 阶段读取内容包或初始化库存。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { resourcesConfigSchema } from "./definition";
import { createResourcesPort } from "./port";

/** 资源实现没有后台任务，暴露端口绑定器供宿主装配。 */
export function createResourcesModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = resourcesConfigSchema.parse(input.config);
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => {
      // 库存由 campaign.start 后续钩子在规则事务内初始化。
    },
    drain: async () => {
      // 没有在途写入。
    },
    dispose: async () => {
      // 没有连接或定时器。
    },
    port: {
      bind: (txFor: Parameters<typeof createResourcesPort>[0]) =>
        createResourcesPort(txFor, {
          scarceRatio: config.scarceRatio,
          surplusRatio: config.surplusRatio,
        }),
    },
  });
}
