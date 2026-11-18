/**
 * 声明 SQLite 存档模块：提供 game.save，不拥有规则聚合。
 * 依赖契约与 module-sdk 描述符校验；实现由 create 加载。
 * 禁止在这里访问存储或执行分支复制。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const saveConfigSchema = z.object({}).strict();

const saveDefinition: ModuleDefinition = {
  id: "game.save.sqlite",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.save"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: saveConfigSchema,
  defaults: {},
  stateSchemaVersion: 1,
  ownsAggregates: [],
  migrationPaths: [],
  create: async (input) => {
    const { createSaveModule } = await import("./plugin");
    return createSaveModule(input);
  },
};

/** 经描述符校验的 SQLite 存档模块定义。 */
export const saveModuleDefinition = defineModule(saveDefinition);
