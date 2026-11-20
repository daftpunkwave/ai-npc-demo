/**
 * 声明控制台模块与装配页面。
 * 依赖远端模块管理能力；不直接读配置文件或执行模块工厂。
 * 禁止在浏览器端保存或热套用未经预检的装配。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineBrowserModule } from "@ai-npc/client-sdk/define-browser-module";
import { z } from "zod";

const definition: ModuleDefinition = {
  id: "console.module-admin.standard",
  realm: "console",
  kind: "contributor",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "session",
  provides: [
    {
      capability: capabilityIdSchema.parse("console.module-admin"),
      cardinality: "exactly-one",
      instanceScope: "session",
    },
  ],
  requires: [],
  requiresRemote: [capabilityIdSchema.parse("platform.module-admin")],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  contributions: [
    {
      extensionId: "console.module-admin.standard.page",
      slot: "console.page",
      order: 20,
      allowedRoles: ["operator", "researcher"],
    },
  ],
  create: async (input) => {
    const { createModuleAdminPageModule } = await import("./plugin");
    return createModuleAdminPageModule(input);
  },
};

export const moduleAdminPageModuleDefinition = defineBrowserModule(definition);
