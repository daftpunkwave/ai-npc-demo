/**
 * 声明标准对话模块，向底部 dialogue slot 贡献已提交对白与发言输入。
 * 依赖玩家授权投影和选择端口；不持有 Agent 私有决策上下文。
 * 禁止把模型流式 token、未提交台词或控制台真值展示给玩家。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const dialogueModuleDefinition = defineBrowserModuleDefinition({
  id: "client.dialogue.standard",
  kind: "contributor",
  provides: "client.dialogue",
  requires: ["client.world-view", "client.input"],
  contributions: [
    {
      extensionId: "client.dialogue.standard.bottom",
      slot: "dialogue",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createDialogueModule } = await import("./plugin");
    return createDialogueModule(input);
  },
});
