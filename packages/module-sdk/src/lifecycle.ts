/**
 * 为没有后台任务的服务端模块提供统一的生命周期骨架。
 * 依赖公共契约的模块创建输入与实例类型；端口由调用方在创建时传入。
 * 禁止在这里启动循环、读取配置或把端口实现耦合进宿主。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";

/** 构造无后台任务的模块实例；调用方只需提供可选端口。 */
export function createStatelessModule(input: ModuleCreateInput, port?: unknown): Promise<ModuleInstance> {
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => {
      // 无后台任务的模块在启动阶段不需要动作。
    },
    drain: async () => {
      // 没有在途写入需要排空。
    },
    dispose: async () => {
      // 没有连接、订阅或定时器需要释放。
    },
    ...(port === undefined ? {} : { port }),
  });
}
