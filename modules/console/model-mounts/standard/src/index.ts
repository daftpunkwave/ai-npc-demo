/**
 * 核心职责：汇总模型布局页面定义与包标识。
 * 交互契约：向控制台目录导出模块定义，不直接调用宿主端口。
 * 约束与禁忌：不读取凭据正文、不发起供应商请求，也不启动模型传输。
 */
export const packageName = "@ai-npc/mod-console-model-mounts-standard";
export { modelMountsPageModuleDefinition } from "./definition";
