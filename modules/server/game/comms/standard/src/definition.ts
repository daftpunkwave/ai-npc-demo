/**
 * 声明标准通信模块的身份、能力、聚合所有权与依赖。
 * 依赖公共契约的模块类型与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取内容、存储或注册通信命令。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const commsConfigSchema = z.object({}).strict();

const commsDefinition: ModuleDefinition = {
  id: "game.comms.standard",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.comms"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [
    {
      capability: capabilityIdSchema.parse("game.world"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requiresRemote: [],
  configSchema: commsConfigSchema,
  defaults: {},
  stateSchemaVersion: 1,
  ownsAggregates: ["conversation", "knowledge-grant"],
  migrationPaths: [],
  create: async (input) => {
    const { createCommsModule } = await import("./plugin");
    return createCommsModule(input);
  },
};

/** 经描述符校验的标准通信模块定义。 */
export const commsModuleDefinition = defineModule(commsDefinition);
