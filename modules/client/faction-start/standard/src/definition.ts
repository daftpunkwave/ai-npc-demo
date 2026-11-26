/**
 * 声明开局选择模块，向 boot.screen slot 贡献公社席启动流程。
 * 依赖玩家投影和 campaign 视图；不直接创建世界或绕过命令网关。
 * 禁止把未启用派系伪装成可选开局。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const factionStartModuleDefinition = defineBrowserModuleDefinition({
  id: "client.faction-start.standard",
  kind: "contributor",
  provides: "client.faction-start",
  requires: ["client.world-view"],
  contributions: [
    {
      extensionId: "client.faction-start.standard.boot",
      slot: "boot.screen",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createFactionStartModule } = await import("./plugin");
    return createFactionStartModule(input);
  },
});
