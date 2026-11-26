/**
 * 声明标准行动模块的身份、能力、聚合所有权与依赖。
 * 依赖公共契约的模块类型与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取内容、存储或注册任务处理器。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

const actionsConfigSchema = z.object({}).strict();

/**
 * 本模块独占写入的聚合类型；模块定义（进入 manifest 摘要）与规则贡献（authority 写权限）共用这一份声明。
 */
export const actionsOwnedAggregates = ["task", "task-invitation"] as const;

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
  ownsAggregates: actionsOwnedAggregates,
  migrationPaths: [],
  create: async (input) => {
    const { createActionsModule } = await import("./plugin");
    return createActionsModule(input);
  },
};

/** 经描述符校验的标准行动模块定义。 */
export const actionsModuleDefinition = defineModule(actionsDefinition);
