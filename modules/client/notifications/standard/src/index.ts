/**
 * 核心职责：汇总标准通知模块定义。
 * 交互契约：只导出通知模块定义与公开端口。
 * 约束与禁忌：不读取日志、模型调用或控制台事件。
 */
export const packageName = "@ai-npc/mod-client-notifications-standard";
export { notificationsModuleDefinition } from "./definition";
