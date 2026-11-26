/**
 * 声明标准协议模块的身份、能力、聚合所有权与依赖。
 * 依赖公共契约的模块类型与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取内容、存储或注册协议处理器。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

const agreementsConfigSchema = z.object({}).strict();

const agreementsDefinition: ModuleDefinition = {
  id: "game.agreements.standard",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.agreements"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [
    { capability: capabilityIdSchema.parse("game.world"), cardinality: "exactly-one", instanceScope: "run" },
    { capability: capabilityIdSchema.parse("game.map"), cardinality: "exactly-one", instanceScope: "run" },
    { capability: capabilityIdSchema.parse("game.actions"), cardinality: "exactly-one", instanceScope: "run" },
    { capability: capabilityIdSchema.parse("game.comms"), cardinality: "exactly-one", instanceScope: "run" },
  ],
  requiresRemote: [],
  configSchema: agreementsConfigSchema,
  defaults: {},
  stateSchemaVersion: 1,
  ownsAggregates: ["agreement"],
  migrationPaths: [],
  create: async (input) => {
    const { createAgreementsModule } = await import("./plugin");
    return createAgreementsModule(input);
  },
};

/** 经描述符校验的标准协议模块定义。 */
export const agreementsModuleDefinition = defineModule(agreementsDefinition);
