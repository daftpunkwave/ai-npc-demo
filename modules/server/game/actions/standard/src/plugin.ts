/**
 * 创建标准行动模块实例；没有后台任务，端口由宿主按事务绑定。
 * 依赖无状态生命周期骨架、规则贡献与端口工厂。
 * 禁止在 create 阶段读取内容、创建任务或启动风险抽样。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
import { createActionsContributor } from "./contributor";
import { createActionsPort } from "./port";

/** 行动模块实例的公开端口同时暴露事务绑定器与规则贡献。 */
export function createActionsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, {
    bind: createActionsPort,
    contributor: createActionsContributor(),
  });
}
