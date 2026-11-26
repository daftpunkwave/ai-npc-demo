/**
 * 声明六节点地图模块的身份、能力、聚合所有权与严格配置。
 * 依赖公共契约的模块类型与 module-sdk 的描述符校验；实现由 create 动态加载。
 * 禁止在这里读取内容包、访问存储或注册规则处理器。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

const mapConfigSchema = z
  .object({
    maxNodes: z.number().int().positive().default(64),
  })
  .strict();

/**
 * 本模块独占写入的聚合类型；模块定义（进入 manifest 摘要）与规则贡献（authority 写权限）共用这一份声明。
 */
export const mapOwnedAggregates = ["road", "passage-grant"] as const;

const mapDefinition: ModuleDefinition = {
  id: "game.map.six-nodes",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.map"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: mapConfigSchema,
  defaults: { maxNodes: 64 },
  stateSchemaVersion: 1,
  ownsAggregates: mapOwnedAggregates,
  migrationPaths: [],
  create: async (input) => {
    const { createMapModule } = await import("./plugin");
    return createMapModule(input);
  },
};

/** 经描述符校验的六节点地图模块定义；组合根只登记这一入口。 */
export const mapModuleDefinition = defineModule(mapDefinition);
