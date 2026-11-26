/**
 * 声明研究员的只读观测页面，提供世界时间线、Agent 检查器、turn 证据、trace 树与 Artifact 查看。
 * 依赖远端平台观测能力；不读取原始模型密钥或改变游戏世界。
 * 禁止让运营或评估角色通过页面绕过服务端角色范围。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const observabilityPageModuleDefinition = defineBrowserModuleDefinition({
  id: "console.observability.standard",
  kind: "contributor",
  provides: "console.observability",
  requiresRemote: ["platform.observability"],
  contributions: [
    {
      extensionId: "console.observability.standard.page",
      slot: "console.page",
      order: 30,
      allowedRoles: ["researcher"],
    },
  ],
  create: async (input) => {
    const { createObservabilityPageModule } = await import("./plugin");
    return createObservabilityPageModule(input);
  },
});
