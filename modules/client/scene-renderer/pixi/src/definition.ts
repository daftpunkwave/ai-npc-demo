/**
 * 声明 PixiJS 灰盒场景适配器，并向 scene slot 贡献可替换画布。
 * 依赖世界视图、相机、屏幕投影与输入能力；不读取服务端数据库或私密内容。
 * 禁止由渲染器决定路径、位置、命中权限或任务完成结果。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const pixiSceneModuleDefinition = defineBrowserModuleDefinition({
  id: "client.scene-renderer.pixi",
  kind: "adapter",
  provides: "client.scene-renderer",
  requires: [
    "client.world-view",
    "client.camera",
    "client.screen-projection",
    "client.input",
  ],
  contributions: [
    {
      extensionId: "client.scene-renderer.pixi.scene",
      slot: "scene",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createPixiSceneModule } = await import("./plugin");
    return createPixiSceneModule(input);
  },
});
