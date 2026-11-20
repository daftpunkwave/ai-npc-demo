/**
 * 声明标准对话模块，向底部 dialogue slot 贡献已提交对白与发言输入。
 * 依赖玩家授权投影和选择端口；不持有 Agent 私有决策上下文。
 * 禁止把模型流式 token、未提交台词或控制台真值展示给玩家。
 */
import { capabilityIdSchema, type CapabilityRef, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

function requirement(capability: string): CapabilityRef {
  return {
    capability: capabilityIdSchema.parse(capability),
    cardinality: "exactly-one",
    instanceScope: "session",
  };
}

const definition: ModuleDefinition = {
  id: "client.dialogue.standard",
  realm: "client",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.dialogue"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [requirement("client.world-view"), requirement("client.input")],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
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
};

export const dialogueModuleDefinition = defineBrowserModule(definition);
