/**
 * 核心职责：声明按历史组尾部保留并按预算裁剪的窗口压缩能力。
 * 交互契约：阈值与目标比例属于已冻结的 profile 配置。
 * 约束与禁忌：不得改写受保护段、工具配对或当前输入。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export const windowCompressionConfigSchema = z
  .object({
    triggerRatio: z.number().positive().max(1),
    preserveRecentGroups: z.number().int().nonnegative(),
    targetTokenRatio: z.number().positive().max(1),
  })
  .strict();

export type WindowCompressionConfig = z.infer<typeof windowCompressionConfigSchema>;

const definition: ModuleDefinition = {
  id: "agent.compression.window",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [{
    capability: capabilityIdSchema.parse("agent.compression"),
    cardinality: "exactly-one",
    instanceScope: "agent",
  }],
  requires: [],
  requiresRemote: [],
  configSchema: windowCompressionConfigSchema,
  defaults: { triggerRatio: 0.8, preserveRecentGroups: 4, targetTokenRatio: 0.6 },
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createCompressionWindowModule } = await import("./plugin");
    return createCompressionWindowModule(input);
  },
};

export const compressionWindowModuleDefinition = defineModule(definition);
