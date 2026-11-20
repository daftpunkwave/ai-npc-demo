/**
 * 声明本地感知模块的槽位能力、配置和生命周期。
 * 依赖公共模块契约与 module-sdk 描述符校验。
 * 禁止在定义文件加载插件实现或读取内容包。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export const perceptionConfigSchema = z
  .object({
    visibleGraphDepth: z.number().int().min(0).max(1),
    extraDelayTicks: z
      .object({
        broadcast: z.number().int().nonnegative(),
        directed: z.number().int().nonnegative(),
        briefing: z.number().int().nonnegative(),
      })
      .strict(),
    maxObservationsPerBatch: z.number().int().positive(),
    retainUncertainCues: z.boolean(),
  })
  .strict();

export type PerceptionConfig = z.infer<typeof perceptionConfigSchema>;

const definition: ModuleDefinition = {
  id: "agent.perception.local",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [
    {
      capability: capabilityIdSchema.parse("agent.perception"),
      cardinality: "exactly-one",
      instanceScope: "agent",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: perceptionConfigSchema,
  defaults: {
    visibleGraphDepth: 0,
    extraDelayTicks: { broadcast: 0, directed: 0, briefing: 0 },
    maxObservationsPerBatch: 12,
    retainUncertainCues: true,
  },
  stateSchemaVersion: 1,
  migrationPaths: [],
  create: async (input) => {
    const { createPerceptionModule } = await import("./plugin");
    return createPerceptionModule(input);
  },
};

export const perceptionModuleDefinition = defineModule(definition);
