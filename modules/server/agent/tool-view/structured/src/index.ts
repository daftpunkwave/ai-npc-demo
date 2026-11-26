/**
 * 核心职责：公开结构化工具视图模块定义与配置 schema。
 * 交互契约：只导出描述符与配置类型，不加载实例。
 * 约束与禁忌：不得在此读取原始工具结果。
 */
export const packageName = "@world-prism/mod-agent-tool-view-structured";
export { structuredToolViewConfigSchema, structuredToolViewModuleDefinition } from "./definition";
