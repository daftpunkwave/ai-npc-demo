/**
 * 核心职责：汇总人物与场景侧栏模块定义。
 * 交互契约：只导出 packageName 与 charactersModuleDefinition。
 * 约束与禁忌：不读取服务端存储或复制业务规则。
 */
export const packageName = "@world-prism/mod-client-characters-standard";
export { charactersModuleDefinition } from "./definition";
