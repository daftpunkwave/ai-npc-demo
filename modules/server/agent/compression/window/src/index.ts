/**
 * 核心职责：公开窗口压缩模块定义与配置 schema。
 * 交互契约：调用方可读取纯描述符和配置类型。
 * 约束与禁忌：不得加载实现或保留跨 turn 历史。
 */
export const packageName = "@world-prism/mod-agent-compression-window";
export { windowCompressionConfigSchema, compressionWindowModuleDefinition } from "./definition";
