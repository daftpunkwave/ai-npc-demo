/**
 * 汇总六节点地图模块的公开入口：模块定义、端口工厂与聚合状态类型。
 * 依赖定义文件与端口实现；宿主只经组合根登记定义，测试可构造事务内端口。
 * 禁止在这里静态打开存储或注册全局处理器。
 */
export const packageName = "@ai-npc/mod-game-map-six-nodes";

export { mapModuleDefinition } from "./definition";
export { createMapContributor } from "./contributor";
export { createMapPort } from "./port";
export { passageGrantStateSchema, readMapState, roadStateSchema } from "./state";
export type { PassageGrantState, RoadState } from "./state";
