/**
 * 核心职责：汇总标准 HUD 模块定义。
 * 交互契约：只导出 HUD 模块定义与公开端口。
 * 约束与禁忌：不读取服务端存储或创建网络连接。
 */
export const packageName = "@world-prism/mod-client-hud-standard";
export { hudModuleDefinition } from "./definition";
