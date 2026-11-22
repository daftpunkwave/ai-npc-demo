/**
 * 核心职责：声明公平调度模块的 run 级能力和配置。
 * 交互契约：只导出 definition 描述符与配置 schema，依赖 contracts 与 module-sdk。
 * 约束与禁忌：不在此实现调度算法、加载实例或持有状态。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export const schedulingConfigSchema = z
  .object({
    maxConcurrentTurns: z.number().int().positive(),
    mergeLimit: z.number().int().positive(),
    cooldownTicks: z.number().int().nonnegative(),
    agingPerTick: z.number().int().nonnegative(),
    agingCap: z.number().int().nonnegative(),
    patrolHour: z.number().int().min(0).max(23),
  })
  .strict();

export type SchedulingConfig = z.infer<typeof schedulingConfigSchema>;

const definition: ModuleDefinition = {
  id: "agent.scheduling.fair",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "run",
  provides: [
    {
      capability: capabilityIdSchema.parse("agent.scheduling"),
      cardinality: "exactly-one",
      instanceScope: "run",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: schedulingConfigSchema,
  defaults: {
    maxConcurrentTurns: 4,
    mergeLimit: 5,
    cooldownTicks: 1,
    agingPerTick: 5,
    agingCap: 40,
    patrolHour: 8,
  },
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createSchedulingModule } = await import("./plugin");
    return createSchedulingModule(input);
  },
};

export const schedulingModuleDefinition = defineModule(definition);
