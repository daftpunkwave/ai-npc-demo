/**
 * 核心职责：汇总调试页面定义与包标识。
 * 交互契约：向控制台目录导出模块定义，不直接调用 API 或宿主端口。
 * 约束与禁忌：不执行重放、唤醒或任何持久化副作用。
 */
export const packageName = "@ai-npc/mod-console-debug-standard";
export { debugPageModuleDefinition } from "./definition";
