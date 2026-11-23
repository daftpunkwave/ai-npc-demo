/**
 * 核心职责：汇总势力运营页面定义与包标识。
 * 交互契约：向控制台目录导出模块定义，不直接调用 API 或宿主端口。
 * 约束与禁忌：不直接访问存储、时钟或模型传输。
 */
export const packageName = "@ai-npc/mod-console-faction-ops-standard";
export { factionOpsPageModuleDefinition } from "./definition";
