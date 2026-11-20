/**
 * 声明控制台模块与装配页面。
 * 依赖远端模块管理能力；不直接读配置文件或执行模块工厂。
 * 禁止在浏览器端保存或热套用未经预检的装配。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const moduleAdminPageModuleDefinition = defineBrowserModuleDefinition({
  id: "console.module-admin.standard",
  kind: "contributor",
  provides: "console.module-admin",
  requiresRemote: ["platform.module-admin"],
  contributions: [
    {
      extensionId: "console.module-admin.standard.page",
      slot: "console.page",
      order: 20,
      allowedRoles: ["operator", "researcher"],
    },
  ],
  create: async (input) => {
    const { createModuleAdminPageModule } = await import("./plugin");
    return createModuleAdminPageModule(input);
  },
});
