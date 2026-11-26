/**
 * 汇总轻资源模块的公开入口：模块定义、端口工厂与库存状态工具。
 * 依赖定义文件、端口实现与状态 schema；宿主只经组合根登记定义。
 * 禁止在这里静态打开存储或初始化库存。
 */
export const packageName = "@world-prism/mod-game-resources-light";

export { resourcesModuleDefinition } from "./definition";
export { createResourcesContributor } from "./contributor";
export { createResourcesPort, resourceOrder, stockpileSchema, stockpileView } from "./port";
export type { ResourcesPortOptions } from "./port";
export { readStockpile, stockpileStateSchema } from "./state";
export type { StockpileState } from "./state";
