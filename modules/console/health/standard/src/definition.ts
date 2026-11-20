/**
 * 声明控制台运行总览页面模块。
 * 依赖远端观测与运营能力；不直接连接数据库或读取模型凭据。
 * 禁止把页面隐藏当作服务端授权，也不让评估角色进入运营视图。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const definition: ModuleDefinition = {
  id: "console.health.standard",
  realm: "console",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("console.health"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [],
  requiresRemote: [
    capabilityIdSchema.parse("platform.observability"),
    capabilityIdSchema.parse("platform.operations"),
  ],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  contributions: [
    {
      extensionId: "console.health.standard.page",
      slot: "console.page",
      order: 10,
      allowedRoles: ["operator", "researcher"],
    },
  ],
  create: async (input) => {
    const { createHealthPageModule } = await import("./plugin");
    return createHealthPageModule(input);
  },
};

export const healthPageModuleDefinition = defineBrowserModule(definition);
