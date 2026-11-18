/**
 * 声明世界模块的身份、能力、聚合所有权、依赖与严格配置。
 * 依赖公共契约的模块类型与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取内容包、访问存储或注册事件处理器。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const worldConfigSchema = z
  .object({
    chapterLengthTicks: z.number().int().positive().default(168),
  })
  .strict();

const worldDefinition: ModuleDefinition = {
  id: "game.world.slg-light",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("game.world"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [
    {
      capability: capabilityIdSchema.parse("game.map"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
    {
      capability: capabilityIdSchema.parse("game.resources"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requiresRemote: [],
  configSchema: worldConfigSchema,
  defaults: { chapterLengthTicks: 168 },
  stateSchemaVersion: 1,
  ownsAggregates: [
    "campaign",
    "meters",
    "character",
    "team",
    "group",
    "delegation",
    "evidence-placement",
    "chapter-stats",
  ],
  migrationPaths: [],
  create: async (input) => {
    const { createWorldModule } = await import("./plugin");
    return createWorldModule(input);
  },
};

/** 经描述符校验的世界模块定义。 */
export const worldModuleDefinition = defineModule(worldDefinition);
