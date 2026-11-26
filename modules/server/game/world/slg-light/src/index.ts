/**
 * 汇总世界模块的公开入口：模块定义、端口工厂、规则贡献与状态工具。
 * 依赖定义、端口、处理器与状态文件；宿主只经组合根登记定义。
 * 禁止在这里静态打开存储或执行 campaign 初始化。
 */
export const packageName = "@ai-npc/mod-game-world-slg-light";

export {
  defaultChapterLengthTicks,
  worldConfigSchema,
  worldModuleDefinition,
  type WorldConfig,
} from "./definition";
export { createWorldContributor } from "./contributor";
export { campaignAggregateId, cargoExceedsCapacity, createWorldPort, metersAggregateId } from "./port";
export { clampMeter, metersSnapshot, thresholdEvents } from "./meters";
export type { MeterThresholdEvent } from "./meters";
export { readWorldState } from "./state";
export type {
  CampaignState,
  CharacterState,
  DelegationState,
  EvidencePlacementState,
  GroupState,
  MetersState,
  TeamState,
} from "./state";
