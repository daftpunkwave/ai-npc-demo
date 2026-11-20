/**
 * 声明玩家显示、镜头、存档与无障碍设置模块。
 * 依赖玩家投影与本地偏好端口；不改变世界规则、权限或当前模块装配。
 * 禁止把偏好保存当作服务端存档，也禁止从设置入口读取后台配置。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const settingsModuleDefinition = defineBrowserModuleDefinition({
  id: "client.settings.standard",
  kind: "contributor",
  provides: "client.settings",
  requires: ["client.world-view"],
  contributions: [
    {
      extensionId: "client.settings.standard.section",
      slot: "settings.section",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createSettingsModule } = await import("./plugin");
    return createSettingsModule(input);
  },
});
