/**
 * 核心职责：汇总 PixiJS 场景适配器定义。
 * 交互契约：只导出 PixiJS 场景模块定义与公开端口。
 * 约束与禁忌：不创建画布或初始化 WebGL。
 */
export const packageName = "@world-prism/mod-client-scene-renderer-pixi";
export { pixiSceneModuleDefinition } from "./definition";
