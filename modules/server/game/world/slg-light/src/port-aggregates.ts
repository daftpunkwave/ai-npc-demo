/**
 * 核心职责：定义世界聚合的固定聚合 ID 常量。
 * 交互契约：campaign 与 meters 每个分支各一条；端口实现与初始化贡献者共享同一常量。
 * 约束与禁忌：禁止在这里携带状态或实现规则。
 */
/** 世界聚合的固定 ID；campaign 与 meters 每个分支各一条。 */
export const campaignAggregateId = "campaign";
export const metersAggregateId = "meters";
