/**
 * 声明客户端相机模块的会话能力与空配置。
 * 依赖公共模块契约；实现通过动态入口加载，不读取世界数据。
 * 禁止在描述符中创建计时器、订阅或浏览器画布。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const cameraModuleDefinition = defineBrowserModuleDefinition({
  id: "client.camera.standard",
  kind: "service",
  provides: "client.camera",
  create: async (input) => {
    const { createCameraModule } = await import("./plugin");
    return createCameraModule(input);
  },
});
