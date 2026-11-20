/**
 * 声明无长期记忆模块的 agent 级能力与空配置。
 * Declares the no-long-term-memory module as an agent-scoped service.
 * Depends on the shared module contract and descriptor validation only.
 * Must not load the implementation or preserve hidden history.
 */
import {
  capabilityIdSchema,
  emptyModuleConfigSchema,
  type ModuleDefinition,
} from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";

const definition: ModuleDefinition = {
  id: "agent.memory.none",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [
    {
      capability: capabilityIdSchema.parse("agent.memory"),
      cardinality: "exactly-one",
      instanceScope: "agent",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: 1,
  migrationPaths: [],
  create: async (input) => {
    const { createMemoryNoneModule } = await import("./plugin");
    return createMemoryNoneModule(input);
  },
};

export const memoryNoneModuleDefinition = defineModule(definition);
