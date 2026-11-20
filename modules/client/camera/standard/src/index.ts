/**
 * 汇总客户端相机模块定义与公开端口。
 * 不创建浏览器画布或读取世界状态。
 */
export const packageName = "@ai-npc/mod-client-camera-standard";
export { cameraModuleDefinition } from "./definition";
export type { CameraPort, CameraState } from "./plugin";
