/**
 * 声明无长期记忆模块的 agent 级能力与空配置。
 * 只依赖共享模块契约与描述符校验。
 * 禁止加载实现或保留隐藏历史。
 */
import {
  capabilityIdSchema,
  emptyModuleConfigSchema,
  type ModuleDefinition,
} from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";

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
