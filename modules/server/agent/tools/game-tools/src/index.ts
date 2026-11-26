/**
 * 核心职责：公开游戏工具模块定义、工具集配置 schema 与端口类型。
 * 交互契约：调用方只读取描述符数据，实现实例由模块工厂按需加载。
 * 约束与禁忌：不得在此执行命令、访问世界状态或扩大 binding 权限。
 */
export const packageName = "@world-prism/mod-agent-tools-game-tools";
export {
  gameToolsConfigSchema,
  gameToolsModuleDefinition,
  type GameToolsConfig,
} from "./definition";
export { toolsetDocumentSchema, type ToolsetDocument } from "@world-prism/contracts";
export type { GameToolsCatalogPort } from "./plugin";
