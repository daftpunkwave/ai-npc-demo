/**
 * 注册地图模块的聚合所有权；地图没有命令或 job 处理器，写操作由其他模块经端口调用。
 * 依赖模块 SDK 的规则贡献类型与本模块定义声明的模块 ID。
 * 禁止在这里注册未实现的命令或绕过 authority 的写作用域。
 */
import type { GameRuleContributor, GameModulePorts } from "@world-prism/module-sdk";
import { mapModuleDefinition, mapOwnedAggregates } from "./definition";

/** 让地图聚合进入注册表，供 authority 在绑定时建立受控写作用域。 */
export function createMapContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: mapModuleDefinition.id,
    ownsAggregates: mapOwnedAggregates,
  };
}
