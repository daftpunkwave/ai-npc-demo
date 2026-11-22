/**
 * 核心职责：声明不变换上下文、超限即显式失败的无压缩策略。
 * 交互契约：提供 agent 级 agent.compression 能力且使用严格空配置。
 * 约束与禁忌：不得隐式截断、摘要或修改来源集合。
 */
import {
  capabilityIdSchema,
  emptyModuleConfigSchema,
  type ModuleDefinition,
} from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";

const definition: ModuleDefinition = {
  id: "agent.compression.none",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [{
    capability: capabilityIdSchema.parse("agent.compression"),
    cardinality: "exactly-one",
    instanceScope: "agent",
  }],
  requires: [],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createCompressionNoneModule } = await import("./plugin");
    return createCompressionNoneModule(input);
  },
};

export const compressionNoneModuleDefinition = defineModule(definition);
