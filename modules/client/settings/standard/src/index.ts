/**
 * 核心职责：汇总玩家设置模块定义。
 * 交互契约：只导出设置模块定义与公开端口。
 * 约束与禁忌：不读取服务端配置或模型凭据。
 */
export const packageName = "@ai-npc/mod-client-settings-standard";
export { settingsModuleDefinition } from "./definition";
