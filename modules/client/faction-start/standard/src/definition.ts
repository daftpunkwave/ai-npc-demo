/**
 * 声明开局选择模块，向 boot.screen slot 贡献公社席启动流程。
 * 依赖玩家投影和 campaign 视图；不直接创建世界或绕过命令网关。
 * 禁止把未启用派系伪装成可选开局。
 */
import { capabilityIdSchema, type CapabilityRef, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const requirement: CapabilityRef = {
  capability: capabilityIdSchema.parse("client.world-view"),
  cardinality: "exactly-one",
  instanceScope: "session",
};

const definition: ModuleDefinition = {
  id: "client.faction-start.standard",
  realm: "client",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.faction-start"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [requirement],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  contributions: [
    {
      extensionId: "client.faction-start.standard.boot",
      slot: "boot.screen",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createFactionStartModule } = await import("./plugin");
    return createFactionStartModule(input);
  },
};

export const factionStartModuleDefinition = defineBrowserModule(definition);
