/**
 * 声明等距屏幕投影模块的会话能力与空配置。
 * 依赖公共模块契约；坐标算法由动态实现提供。
 * 禁止把客户端投影结果当作服务端权威路径或位置。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const definition: ModuleDefinition = {
  id: "client.screen-projection.isometric",
  realm: "client",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("client.screen-projection"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createProjectionModule } = await import("./plugin");
    return createProjectionModule(input);
  },
};

export const projectionModuleDefinition = defineBrowserModule(definition);
