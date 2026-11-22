/**
 * 声明 Anthropic Messages 传输的部署级模块与能力。
 * 组合根用这个描述符解析装配并按需加载传输实现。
 * 登记描述符期间禁止导入供应商 SDK、访问网络或解析凭据。
 */
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";

export const anthropicTransportId = "platform.model-transport.anthropic";

export const anthropicTransportDefinition: ModuleDefinition = defineModule({
  id: anthropicTransportId,
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
  create: async (input) => (await import("./plugin")).createAnthropicTransport(input),
});
