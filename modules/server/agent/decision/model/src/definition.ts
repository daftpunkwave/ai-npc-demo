/**
 * 声明模型决策策略的 Agent 作用域。
 * 组合根通过此描述符解析能力依赖并按需启动实现。
 * 禁止在登记时执行模型调用或操作持久化状态。
 */
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { agentModelPoolCapability, defineModule } from "@ai-npc/module-sdk";

export const modelDecisionDefinition: ModuleDefinition = defineModule({
  id: "agent.decision.model",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [{ capability: capabilityIdSchema.parse("agent.decision"), cardinality: "exactly-one", instanceScope: "agent" }],
  requires: [
    // 装配依赖模型池存在；实例创建时宿主在该能力键下注入按必需用途解析的 AgentDecisionModelRoutes 路由视图。
    { capability: agentModelPoolCapability, cardinality: "exactly-one", instanceScope: "deployment" },
  ],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => (await import("./plugin")).createModelDecisionModule(input),
});
