/**
 * 核心职责：声明运营页面的时钟与存档控制入口。
 * 交互契约：依赖远端运营能力；页面不直接修改世界或数据库。
 * 约束与禁忌：不向研究员、评估者或玩家角色开放。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const factionOpsPageModuleDefinition = defineBrowserModuleDefinition({
  id: "console.faction-ops.standard",
  kind: "contributor",
  provides: "console.faction-ops",
  requiresRemote: ["platform.operations", "game.clock"],
  contributions: [
    {
      extensionId: "console.faction-ops.standard.page",
      slot: "console.page",
      order: 40,
      allowedRoles: ["operator"],
    },
  ],
  create: async (input) => {
    const { createFactionOpsPageModule } = await import("./plugin");
    return createFactionOpsPageModule(input);
  },
});
