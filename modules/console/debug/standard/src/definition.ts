/**
 * 核心职责：声明调试队列、审计重放与调试唤醒页面。
 * 交互契约：依赖远端观测能力与研究员浏览器宿主。
 * 约束与禁忌：不直接创建 trigger、读取存储或调用模型。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const debugPageModuleDefinition = defineBrowserModuleDefinition({
  id: "console.debug.standard",
  kind: "contributor",
  provides: "console.debug",
  requiresRemote: ["platform.observability", "game.clock"],
  contributions: [
    {
      extensionId: "console.debug.standard.page",
      slot: "console.page",
      order: 50,
      allowedRoles: ["researcher"],
    },
  ],
  create: async (input) => {
    const { createDebugPageModule } = await import("./plugin");
    return createDebugPageModule(input);
  },
});
