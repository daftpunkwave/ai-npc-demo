/**
 * 核心职责：汇总运行总览页面定义。
 * 交互契约：只导出页面定义与公开类型，不携带运行时数据。
 * 约束与禁忌：不启动轮询或读取服务端数据库。
 */
export const packageName = "@world-prism/mod-console-health-standard";
export { healthPageModuleDefinition } from "./definition";
