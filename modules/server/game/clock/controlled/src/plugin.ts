/**
 * 从宿主注入的存储端口创建受控时钟端口，并在实例生命周期内保持连接引用。
 * 依赖公共契约的模块实例与存储端口类型；配置已由宿主校验。
 * 禁止在模块内启动计时器、自动推进 tick 或在事务外缓存时钟写入。
 */
import { DomainError, type ModuleCreateInput, type ModuleInstance, type StoragePort } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { clockConfigSchema } from "./definition";
import { createClockPort } from "./port";

/** 创建时钟模块实例，端口以 deployment 存储为唯一持久化来源。 */
export function createClockModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = clockConfigSchema.parse(input.config);
  const rawStorage = input.ports["platform.storage"];
  if (rawStorage === undefined) {
    throw new DomainError("assembly-incompatible", "受控时钟缺少 platform.storage 端口");
  }
  const storage = rawStorage as StoragePort;
  return createStatelessModule(input, createClockPort(storage, config, () => input.host.nowIso()));
}
