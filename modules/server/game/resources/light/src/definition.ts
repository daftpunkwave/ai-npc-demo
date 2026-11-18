/**
 * 声明轻资源模块的身份、能力、聚合所有权与严格配置。
 * 依赖公共契约的模块类型与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取库存状态、计算等级或注册命令处理器。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const resourcesConfigSchema = z
  .object({
    scarceRatio: z.number().positive().default(0.3),
    surplusRatio: z.number().positive().default(1.2),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.scarceRatio >= config.surplusRatio) {
      context.addIssue({ code: "custom", message: "短缺阈值必须小于余量阈值" });
    }
  });

const resourcesDefinition: ModuleDefinition = {
  id: "game.resources.light",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.resources"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: resourcesConfigSchema,
  defaults: { scarceRatio: 0.3, surplusRatio: 1.2 },
  stateSchemaVersion: 1,
  ownsAggregates: ["stockpile"],
  migrationPaths: [],
  create: async (input) => {
    const { createResourcesModule } = await import("./plugin");
    return createResourcesModule(input);
  },
};

/** 经描述符校验的轻资源模块定义。 */
export const resourcesModuleDefinition = defineModule(resourcesDefinition);
