/**
 * 声明人物、地点、任务、协议与笔记侧栏模块。
 * 依赖玩家投影和共享选择端口；不复制任务或协议结算规则。
 * 禁止向玩家展示未获知证据、Agent 私有记忆或控制台真值。
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
  id: "client.characters.standard",
  realm: "client",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.characters"),
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
      extensionId: "client.characters.standard.sidebar",
      slot: "sidebar",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createCharactersModule } = await import("./plugin");
    return createCharactersModule(input);
  },
};

export const charactersModuleDefinition = defineBrowserModule(definition);
