/**
 * 声明控制台运行总览页面模块。
 * 依赖远端观测与运营能力；不直接连接数据库或读取模型凭据。
 * 禁止把页面隐藏当作服务端授权，也不让评估角色进入运营视图。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const healthPageModuleDefinition = defineBrowserModuleDefinition({
  id: "console.health.standard",
  kind: "contributor",
  provides: "console.health",
  requiresRemote: [
    "platform.observability",
    "platform.operations",
  ],
  contributions: [
    {
      extensionId: "console.health.standard.page",
      slot: "console.page",
      order: 10,
      allowedRoles: ["operator", "researcher"],
    },
  ],
  create: async (input) => {
    const { createHealthPageModule } = await import("./plugin");
    return createHealthPageModule(input);
  },
});
