/**
 * 核心职责：声明按显式段落顺序组装不可变上下文 artifact 的 agent 级能力。
 * 交互契约：配置只允许已有基线段重排，系统段顺序和内容边界不变。
 * 约束与禁忌：不得读取数据库、模型或会话全局日志。
 */
import type { ModuleDefinition } from "@ai-npc/contracts";
import { capabilityIdSchema } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const segmentKind = z.enum(["world", "task", "memory", "history", "input"]);
const defaultOrder = ["world", "task", "memory", "history", "input"] as const;

const tokenBudget = z.object({
  maxInputTokens: z.number().int().positive(),
  safetyTokens: z.number().int().nonnegative(),
  segmentBudgets: z.partialRecord(segmentKind.or(z.literal("facts")), z.number().int().nonnegative()),
}).strict();

export const orderedBlocksContextConfigSchema = z
  .object({
    segmentOrder: z.array(segmentKind)
      .refine((values) => new Set(values).size === values.length, "segmentOrder cannot contain duplicates")
      .refine((values) => values.length === defaultOrder.length, "segmentOrder must list every user segment")
      .default([...defaultOrder]),
    historyTurns: z.number().int().nonnegative().optional(),
    lendUnusedBudget: z.boolean().optional(),
    decision: tokenBudget.extend({ toolLoopReserveTokens: z.number().int().nonnegative() }).optional(),
    speech: tokenBudget.optional(),
  })
  .strict();

export type OrderedBlocksContextConfig = z.infer<typeof orderedBlocksContextConfigSchema>;

const definition: ModuleDefinition = {
  id: "agent.context.ordered-blocks",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [{
    capability: capabilityIdSchema.parse("agent.context"),
    cardinality: "exactly-one",
    instanceScope: "agent",
  }],
  requires: [],
  requiresRemote: [],
  configSchema: orderedBlocksContextConfigSchema,
  defaults: { segmentOrder: [...defaultOrder] },
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createOrderedBlocksContextModule } = await import("./plugin");
    return createOrderedBlocksContextModule(input);
  },
};

export const orderedBlocksContextDefinition = defineModule(definition);
