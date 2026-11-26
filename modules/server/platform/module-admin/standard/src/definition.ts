/**
 * 声明只读模块目录与装配管理工作台服务。
 * 依赖公共模块与装配契约；不提供草稿写入、热替换或绕过预检的入口。
 * 禁止在描述符阶段扫描文件系统或读取模块实现。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

const definition: ModuleDefinition = {
  id: "platform.module-admin.standard",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [
    {
      capability: capabilityIdSchema.parse("platform.module-admin"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: z.object({}).strict(),
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createModuleAdminModule } = await import("./plugin");
    return createModuleAdminModule(input);
  },
};

export const moduleAdminModuleDefinition = defineModule(definition);
