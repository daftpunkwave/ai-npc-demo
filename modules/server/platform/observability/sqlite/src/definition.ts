/**
 * 声明基于 SQLite 的观测模块，提供跨度归档与控制台时间线查询。
 * 依赖平台存储能力保存自有跨度；他人拥有的数据由宿主启动后绑定的数据源端口提供，查询组装由动态实现负责。
 * 禁止在此读取环境变量、直接打开数据库或向玩家域暴露真值。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

const configSchema = z
  .object({
    timelineLimit: z.number().int().min(1).max(1_000).default(200),
  })
  .strict();

const definition: ModuleDefinition = {
  id: "platform.observability.sqlite",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [
    {
      capability: capabilityIdSchema.parse("platform.observability"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requires: [
    {
      capability: capabilityIdSchema.parse("platform.storage"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requiresRemote: [],
  configSchema,
  defaults: { timelineLimit: 200 },
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createObservabilityModule } = await import("./plugin");
    return createObservabilityModule(input);
  },
};

export const observabilityModuleDefinition = defineModule(definition);
