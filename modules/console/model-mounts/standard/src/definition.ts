/**
 * 核心职责：声明模型布局只读与静态校验页面。
 * 交互契约：依赖远端模型池配置能力与浏览器模块宿主。
 * 约束与禁忌：不加载模型 SDK、不直接读取配置或凭据。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const modelMountsPageModuleDefinition = defineBrowserModuleDefinition({
  id: "console.model-mounts.standard",
  kind: "contributor",
  provides: "console.model-mounts",
  requiresRemote: ["agent.model-pool"],
  contributions: [
    {
      extensionId: "console.model-mounts.standard.page",
      slot: "console.page",
      order: 25,
      allowedRoles: ["operator", "researcher"],
    },
  ],
  create: async (input) => {
    const { createModelMountsPageModule } = await import("./plugin");
    return createModelMountsPageModule(input);
  },
});
