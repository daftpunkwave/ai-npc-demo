/**
 * 声明标准行动模块的身份、能力、聚合所有权与依赖。
 * 依赖公共契约的模块类型与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取内容、存储或注册任务处理器。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const actionsConfigSchema = z.object({}).strict();

const actionsDefinition: ModuleDefinition = {
  id: "game.actions.standard",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.actions"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [
    { capability: capabilityIdSchema.parse("game.world"), cardinality: "exactly-one", instanceScope: "run" },
    { capability: capabilityIdSchema.parse("game.map"), cardinality: "exactly-one", instanceScope: "run" },
    { capability: capabilityIdSchema.parse("game.resources"), cardinality: "exactly-one", instanceScope: "run" },
    { capability: capabilityIdSchema.parse("game.comms"), cardinality: "exactly-one", instanceScope: "run" },
  ],
  requiresRemote: [],
  configSchema: actionsConfigSchema,
  defaults: {},
  stateSchemaVersion: 1,
  ownsAggregates: ["task", "task-invitation"],
  migrationPaths: [],
  create: async (input) => {
    const { createActionsModule } = await import("./plugin");
    return createActionsModule(input);
  },
};

/** 经描述符校验的标准行动模块定义。 */
export const actionsModuleDefinition = defineModule(actionsDefinition);
