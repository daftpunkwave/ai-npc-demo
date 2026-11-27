/**
 * 声明不绘制画面的测试场景适配器，记录最近一次授权场景供确定性测试读取。
 * 只依赖世界视图能力读取授权投影；不属于标准视觉装配。
 * 禁止在测试渲染器中显示或持久化未授权数据。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const nullSceneModuleDefinition = defineBrowserModuleDefinition({
  id: "client.scene-renderer.null",
  kind: "adapter",
  provides: "client.scene-renderer",
  requires: ["client.world-view"],
  contributions: [
    {
      extensionId: "client.scene-renderer.null.scene",
      slot: "scene",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createNullSceneModule } = await import("./plugin");
    return createNullSceneModule(input);
  },
});
