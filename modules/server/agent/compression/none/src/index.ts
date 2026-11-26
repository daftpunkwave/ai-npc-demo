/**
 * 核心职责：公开无压缩模块定义。
 * 交互契约：仅导出描述符，不加载实现或上下文状态。
 * 约束与禁忌：不得在此执行模型摘要。
 */
export const packageName = "@world-prism/mod-agent-compression-none";
export { compressionNoneModuleDefinition } from "./definition";
