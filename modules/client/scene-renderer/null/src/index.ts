/**
 * 核心职责：汇总测试场景适配器定义。
 * 交互契约：只导出测试场景模块定义与公开端口。
 * 约束与禁忌：不初始化画布或 WebGL。
 */
export const packageName = "@world-prism/mod-client-scene-renderer-null";
export { nullSceneModuleDefinition } from "./definition";
