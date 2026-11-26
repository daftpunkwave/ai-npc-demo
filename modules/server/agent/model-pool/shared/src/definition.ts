/**
 * 声明共享模型池及它依赖的传输、预算、密钥、存储和观测端口。
 * 组合根通过此描述符解析能力依赖并按需启动实现。
 * 禁止在登记时执行模型调用或操作持久化状态。
 */
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@world-prism/contracts";
import { agentModelPoolCapability, defineModule } from "@world-prism/module-sdk";

export const sharedModelPoolDefinition: ModuleDefinition = defineModule({
  id: "agent.model-pool.shared",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [{ capability: agentModelPoolCapability, cardinality: "exactly-one", instanceScope: "deployment" }],
  requires: [
    { capability: capabilityIdSchema.parse("platform.model-transport"), cardinality: "many", instanceScope: "deployment" },
    { capability: capabilityIdSchema.parse("platform.budget"), cardinality: "exactly-one", instanceScope: "deployment" },
    { capability: capabilityIdSchema.parse("platform.secrets"), cardinality: "exactly-one", instanceScope: "deployment" },
    { capability: capabilityIdSchema.parse("platform.observability"), cardinality: "exactly-one", instanceScope: "deployment" },
    { capability: capabilityIdSchema.parse("platform.storage"), cardinality: "exactly-one", instanceScope: "deployment" },
  ],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => (await import("./plugin")).createSharedModelPool(input),
});
