/**
 * 从宿主注入的存储端口创建受控时钟端口，并在实例生命周期内保持连接引用。
 * 依赖公共契约的模块实例与存储端口类型；配置已由宿主校验。
 * 禁止在模块内启动计时器、自动推进 tick 或在事务外缓存时钟写入。
 */
import { DomainError, type ModuleCreateInput, type ModuleInstance, type StoragePort } from "@ai-npc/contracts";
import { clockConfigSchema } from "./definition";
import { createClockPort } from "./port";

/** 创建时钟模块实例，端口以 deployment 存储为唯一持久化来源。 */
export function createClockModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = clockConfigSchema.parse(input.config);
  const storage = input.ports["platform.storage"] as StoragePort | undefined;
  if (storage === undefined) {
    return Promise.reject(new DomainError("assembly-incompatible", "受控时钟缺少 platform.storage 端口"));
  }
  const port = createClockPort(storage, config, input.host.nowIso);
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => {
      // 时钟表由宿主在创建分支时写入初值；模块不自动开启 running。
    },
    drain: async () => {
      // 所有时钟写入都是同步事务，没有在途工作。
    },
    dispose: async () => {
      // 存储连接由 platform.storage 模块负责关闭。
    },
    port,
  });
}
