/**
 * 创建轻资源模块实例；库存写入只发生在规则事务内，模块本身不持有连接。
 * 依赖模块配置、无状态生命周期骨架与端口工厂。
 * 禁止在 create 阶段读取内容包或初始化库存。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { resourcesConfigSchema } from "./definition";
import { createResourcesPort } from "./port";

/** 资源实现没有后台任务，暴露端口绑定器供宿主装配。 */
export function createResourcesModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = resourcesConfigSchema.parse(input.config);
  return createStatelessModule(input, {
    bind: (txFor: Parameters<typeof createResourcesPort>[0]) =>
      createResourcesPort(txFor, {
        scarceRatio: config.scarceRatio,
        surplusRatio: config.surplusRatio,
      }),
  });
}
