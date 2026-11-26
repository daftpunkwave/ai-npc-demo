/**
 * 声明首章剧情模块与升级版模块；两者读取同一内容包、共享效果实现。
 * 依赖公共契约与 module-sdk 描述符校验；实现由 create 动态加载。
 * 禁止在这里读取内容、调度卡片或订阅事件。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

const scenarioConfigSchema = z.object({}).strict();

function definition(id: string): ModuleDefinition {
  const requirements = ["game.world", "game.map", "game.resources", "game.comms"] as const;
  return {
    id,
    realm: "server",
    kind: "service",
    version: "1.0.0",
    apiVersion: "1",
    instanceScope: "run",
    provides: [
      {
        capability: capabilityIdSchema.parse("game.scenario"),
        cardinality: "exactly-one",
        instanceScope: "run",
      },
    ],
    requires: requirements.map((capability) => ({
      capability: capabilityIdSchema.parse(capability),
      cardinality: "exactly-one" as const,
      instanceScope: "run" as const,
    })),
    requiresRemote: [],
    configSchema: scenarioConfigSchema,
    defaults: {},
    stateSchemaVersion: 1,
    ownsAggregates: ["scenario-card", "scenario-run"],
    migrationPaths: [],
    create: async (input) => {
      const { createScenarioModule } = await import("./plugin");
      return createScenarioModule(input, id === "game.scenario.watergate-escalating");
    },
  };
}

/** 标准节奏剧情模块。 */
export const scenarioModuleDefinition = defineModule(definition("game.scenario.watergate"));

/** 升级节奏剧情模块；作为标准模块的替换实现。 */
export const escalatingScenarioModuleDefinition = defineModule(
  definition("game.scenario.watergate-escalating"),
);
