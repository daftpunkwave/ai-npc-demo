/**
 * 核心职责：汇总研究观测页面定义。
 * 交互契约：只导出页面定义与公开类型，不携带观测记录。
 * 约束与禁忌：不归档事件或读取私密模型输入。
 */
export const packageName = "@world-prism/mod-console-observability-standard";
export { observabilityPageModuleDefinition } from "./definition";
