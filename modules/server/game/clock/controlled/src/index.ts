/**
 * 汇总受控时钟模块的公开入口：模块定义与端口工厂。
 * 依赖定义文件与端口实现；宿主只经组合根登记定义。
 * 禁止在这里启动时钟循环或读取环境变量。
 */
export const packageName = "@world-prism/mod-game-clock-controlled";

export { clockModuleDefinition, clockConfigSchema } from "./definition";
export { createClockPort } from "./port";
export type { ClockConfig } from "./state";
