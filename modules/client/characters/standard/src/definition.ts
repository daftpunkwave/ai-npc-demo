/**
 * 声明人物、地点、任务、协议与笔记侧栏模块。
 * 依赖玩家投影和共享选择端口；不复制任务或协议结算规则。
 * 禁止向玩家展示未获知证据、Agent 私有记忆或控制台真值。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const charactersModuleDefinition = defineBrowserModuleDefinition({
  id: "client.characters.standard",
  kind: "contributor",
  provides: "client.characters",
  requires: ["client.world-view", "client.input"],
  contributions: [
    {
      extensionId: "client.characters.standard.sidebar",
      slot: "sidebar",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createCharactersModule } = await import("./plugin");
    return createCharactersModule(input);
  },
});
