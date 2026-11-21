/**
 * 声明结构化记忆账本的槽位能力、严格配置与 agent 作用域。
 * Declares the structured-ledger memory module and its strict configuration.
 * Depends on shared contracts and descriptor validation only.
 * Must not execute storage, model calls, or active plugin loading here.
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

const recallConfigSchema = z
  .object({
    mustIncludeProspective: z.number().int().nonnegative(),
    mustIncludeAboutCounterpart: z.number().int().nonnegative(),
    topK: z.number().int().positive(),
    candidateLimit: z.number().int().positive(),
    weights: z
      .object({
        strength: z.number().nonnegative(),
        salience: z.number().nonnegative(),
        relevance: z.number().nonnegative(),
        recency: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const ledgerConfigSchema = z
  .object({
    capacity: z
      .object({
        short: z.number().int().positive(),
        long: z.number().int().positive(),
        core: z.number().int().positive(),
      })
      .strict(),
    salienceThresholds: z
      .object({
        long: z.number().min(0).max(1),
        short: z.number().min(0).max(1),
      })
      .strict()
      .refine(
        (thresholds) => thresholds.long >= thresholds.short,
        "long salience threshold must be greater than or equal to the short threshold",
      ),
    decayBaseTicks: z
      .object({
        short: z.number().int().positive(),
        long: z.number().int().positive(),
      })
      .strict(),
    relationModifiersPerTarget: z.number().int().positive(),
    recall: recallConfigSchema,
    relationInput: z.enum(["enabled", "disabled"]),
    prospectiveInput: z.enum(["enabled", "disabled"]),
    wakeups: z.enum(["enabled", "disabled"]),
    reinforcement: z.literal("validated-reference"),
    maintenanceTrigger: z.literal("world-period"),
  })
  .strict();

export type LedgerConfig = z.infer<typeof ledgerConfigSchema>;

const definition: ModuleDefinition = {
  id: "agent.memory.ledger",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [
    {
      capability: capabilityIdSchema.parse("agent.memory"),
      cardinality: "exactly-one",
      instanceScope: "agent",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: ledgerConfigSchema,
  defaults: {
    capacity: { short: 50, long: 120, core: 30 },
    salienceThresholds: { long: 0.5, short: 0.2 },
    decayBaseTicks: { short: 48, long: 480 },
    relationModifiersPerTarget: 20,
    recall: {
      mustIncludeProspective: 5,
      mustIncludeAboutCounterpart: 2,
      topK: 6,
      candidateLimit: 30,
      weights: { strength: 0.35, salience: 0.25, relevance: 0.3, recency: 0.1 },
    },
    relationInput: "enabled",
    prospectiveInput: "enabled",
    wakeups: "enabled",
    reinforcement: "validated-reference",
    maintenanceTrigger: "world-period",
  },
  stateSchemaVersion: 1,
  migrationPaths: [],
  create: async (input) => {
    const { createLedgerMemoryModule } = await import("./plugin");
    return createLedgerMemoryModule(input);
  },
};

export const memoryLedgerModuleDefinition = defineModule(definition);
