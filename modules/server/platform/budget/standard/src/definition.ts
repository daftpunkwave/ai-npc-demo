/**
 * 声明模型预算账本与持久存储依赖。
 * 组合根通过此描述符解析能力依赖并按需启动实现。
 * 禁止在登记时执行模型调用或操作持久化状态。
 */
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";

export const modelBudgetDefinition: ModuleDefinition = defineModule({
  id: "platform.budget.standard",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [{ capability: capabilityIdSchema.parse("platform.budget"), cardinality: "exactly-one", instanceScope: "deployment" }],
  requires: [
    { capability: capabilityIdSchema.parse("platform.storage"), cardinality: "exactly-one", instanceScope: "deployment" },
  ],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => (await import("./plugin")).createModelBudgetModule(input),
});
