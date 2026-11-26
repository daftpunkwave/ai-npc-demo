/**
 * 核心职责：创建分层混合记忆模块，并注入确定性随机源与 ID 服务。
 * 交互契约：依赖已校验配置、模块生命周期辅助与宿主公开端口。
 * 约束与禁忌：禁止读取存储、模型传输层或其他记忆模块实例。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule } from "@world-prism/module-sdk";
import { layeredHybridConfigSchema } from "./layered-hybrid-config";
import { createLayeredHybridPort } from "./layered-hybrid-port";

export function createLayeredHybridMemoryModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = layeredHybridConfigSchema.parse(input.config);
  return createStatelessModule(input, createLayeredHybridPort(config, input.host.ids, input.host.rng));
}