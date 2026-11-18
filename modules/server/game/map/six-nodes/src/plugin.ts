/**
 * 创建六节点地图模块实例；地图实现无后台循环，端口在规则事务内按需绑定。
 * 依赖模块定义与 module-sdk 的无状态生命周期骨架。
 * 禁止在 create 阶段读取内容、打开存储或缓存跨事务状态。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { createMapPort } from "./port";

/** 地图模块没有独立启动资源，暴露端口绑定器供宿主装配。 */
export function createMapModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, { bind: createMapPort });
}
