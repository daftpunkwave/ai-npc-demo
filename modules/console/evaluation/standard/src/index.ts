/**
 * 核心职责：汇总评估页面的公开入口，只导出页面模块定义。
 * 交互契约：宿主经组合根登记定义，浏览器运行期按定义加载实现。
 * 约束与禁忌：不在此携带评估数据、不读取凭据，也不导出页面内部状态。
 */
export const packageName = "@ai-npc/mod-console-evaluation-standard";

export { evaluationPageModuleDefinition } from "./definition";
