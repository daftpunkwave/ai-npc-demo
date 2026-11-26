/**
 * 声明以本地夹具提供单次调用结果的测试传输。
 * 组合根通过此描述符解析能力依赖并按需启动实现。
 * 禁止在登记时执行模型调用或操作持久化状态。
 */
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";

export const deterministicModelTransportDefinition: ModuleDefinition = defineModule({
  id: "platform.model-transport.deterministic",
  realm: "server",
  kind: "adapter",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [{ capability: capabilityIdSchema.parse("platform.model-transport"), cardinality: "many", instanceScope: "deployment" }],
  requires: [],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => (await import("./plugin")).createDeterministicTransport(input),
});
