/**
 * 声明确定性决策的 Agent 作用域与空配置契约。
 * 组合根通过此描述符登记决策能力，运行时按需加载策略。
 * 描述符不持有运行状态或模型连接。
 */
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";

export const deterministicDecisionModuleDefinition: ModuleDefinition = defineModule({
  id: "agent.decision.deterministic",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [{
    capability: capabilityIdSchema.parse("agent.decision"),
    cardinality: "exactly-one",
    instanceScope: "agent",
  }],
  requires: [],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => (await import("./plugin")).createDeterministicDecisionModule(input),
});
