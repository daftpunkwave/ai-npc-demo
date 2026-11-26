/**
 * 声明结构化账本、观察流反思与分层混合三种可替换记忆模块及其严格配置。
 * 依赖共享契约、描述符校验与 zod；配置默认值随描述符冻结。
 * 禁止在此创建实例、读取存储或执行模型调用。
 */
import { agentMemoryRetrievalBudgetSchema, capabilityIdSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";
import { z } from "zod";

export const ledgerRecallConfigSchema = z
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
    retrievalBudget: agentMemoryRetrievalBudgetSchema,
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
    recall: ledgerRecallConfigSchema,
    relationInput: z.enum(["enabled", "disabled"]),
    prospectiveInput: z.enum(["enabled", "disabled"]),
    wakeups: z.enum(["enabled", "disabled"]),
    reinforcement: z.literal("validated-reference"),
    maintenanceTrigger: z.literal("world-period"),
  })
  .strict();

export type LedgerConfig = z.infer<typeof ledgerConfigSchema>;

export const ledgerConfigDefaults: LedgerConfig = {
  retrievalBudget: { maxItems: 8, maxTokens: 1000 },
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
};
export const streamReflectionConfigSchema = z
  .object({
    retrievalBudget: agentMemoryRetrievalBudgetSchema,
    capacity: z
      .object({
        stream: z.number().int().positive(),
        reflections: z.number().int().positive(),
      })
      .strict(),
    retrieval: z
      .object({
        topK: z.number().int().positive(),
        candidateLimit: z.number().int().positive(),
        weights: z
          .object({
            relevance: z.number().nonnegative(),
            recency: z.number().nonnegative(),
            importance: z.number().nonnegative(),
          })
          .strict(),
        recencyDecayPerTick: z.number().gt(0).lte(1),
      })
      .strict(),
    reflection: z
      .object({
        importanceSumThreshold: z.number().positive(),
        recentWindow: z.number().int().positive(),
        maxPerRun: z.number().int().positive().max(10),
        minEvidence: z.number().int().min(2).max(6),
      })
      .strict(),
    maintenanceTrigger: z.literal("importance-threshold"),
  })
  .strict();

export type StreamReflectionConfig = z.infer<typeof streamReflectionConfigSchema>;

export const streamReflectionDefaults: StreamReflectionConfig = {
  retrievalBudget: { maxItems: 8, maxTokens: 1000 },
  capacity: { stream: 300, reflections: 60 },
  retrieval: {
    topK: 6,
    candidateLimit: 40,
    weights: { relevance: 1, recency: 1, importance: 1 },
    recencyDecayPerTick: 0.995,
  },
  reflection: {
    importanceSumThreshold: 15,
    recentWindow: 15,
    maxPerRun: 3,
    minEvidence: 2,
  },
  maintenanceTrigger: "importance-threshold",
};

export const layeredHybridConfigSchema = z
  .object({
    retrievalBudget: agentMemoryRetrievalBudgetSchema,
    capacity: z
      .object({
        short: z.number().int().positive(),
        long: z.number().int().positive(),
        core: z.number().int().positive(),
        beliefs: z.number().int().positive(),
        prospectiveActive: z.number().int().positive(),
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
    coreBlockMaxTokens: z.number().int().positive(),
    chronicle: z
      .object({
        enabled: z.boolean(),
        maxPerRecall: z.number().int().nonnegative(),
      })
      .strict(),
    llmMaintenance: z
      .object({
        enabled: z.boolean(),
        maxAgentsPerDay: z.number().int().positive(),
      })
      .strict(),
    recall: z
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
        jitter: z.number().nonnegative().max(1),
      })
      .strict(),
    relationInput: z.enum(["enabled", "disabled"]),
    prospectiveInput: z.enum(["enabled", "disabled"]),
    wakeups: z.enum(["enabled", "disabled"]),
    reinforcement: z.literal("validated-reference"),
    maintenanceTrigger: z.literal("world-period"),
  })
  .strict();

export type LayeredHybridConfig = z.infer<typeof layeredHybridConfigSchema>;

export const layeredHybridDefaults: LayeredHybridConfig = {
  retrievalBudget: { maxItems: 8, maxTokens: 1000 },
  capacity: { short: 50, long: 120, core: 30, beliefs: 40, prospectiveActive: 20 },
  salienceThresholds: { long: 0.5, short: 0.2 },
  decayBaseTicks: { short: 48, long: 480 },
  relationModifiersPerTarget: 20,
  coreBlockMaxTokens: 300,
  chronicle: { enabled: true, maxPerRecall: 3 },
  llmMaintenance: { enabled: true, maxAgentsPerDay: 8 },
  recall: {
    mustIncludeProspective: 5,
    mustIncludeAboutCounterpart: 2,
    topK: 8,
    candidateLimit: 40,
    weights: { strength: 0.35, salience: 0.25, relevance: 0.3, recency: 0.1 },
    jitter: 0.02,
  },
  relationInput: "enabled",
  prospectiveInput: "enabled",
  wakeups: "enabled",
  reinforcement: "validated-reference",
  maintenanceTrigger: "world-period",
};
interface MemoryDefinitionInput {
  readonly id: string;
  readonly sourceModuleId?: string;
  readonly configSchema: ModuleDefinition["configSchema"];
  readonly defaults: ModuleDefinition["defaults"];
  readonly create: (input: Parameters<ModuleDefinition["create"]>[0]) => ReturnType<ModuleDefinition["create"]>;
}

function memoryDefinition(input: MemoryDefinitionInput): ModuleDefinition {
  return {
    id: input.id,
    ...(input.sourceModuleId === undefined ? {} : { sourceModuleId: input.sourceModuleId }),
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
    configSchema: input.configSchema,
    defaults: input.defaults,
    stateSchemaVersion: 1,
    migrationPaths: [],
    create: input.create,
  };
}

export const memoryLedgerModuleDefinition = defineModule(memoryDefinition({
  id: "agent.memory.ledger",
  configSchema: ledgerConfigSchema,
  defaults: ledgerConfigDefaults,
  create: async (input) => {
    const { createLedgerMemoryModule } = await import("./plugin");
    return createLedgerMemoryModule(input);
  },
}));

export const memoryStreamReflectionModuleDefinition = defineModule(memoryDefinition({
  id: "agent.memory.stream-reflection",
  sourceModuleId: "agent.memory.ledger",
  configSchema: streamReflectionConfigSchema,
  defaults: streamReflectionDefaults,
  create: async (input) => {
    const { createStreamReflectionMemoryModule } = await import("./stream-reflection-plugin");
    return createStreamReflectionMemoryModule(input);
  },
}));

export const memoryLayeredHybridModuleDefinition = defineModule(memoryDefinition({
  id: "agent.memory.layered-hybrid",
  sourceModuleId: "agent.memory.ledger",
  configSchema: layeredHybridConfigSchema,
  defaults: layeredHybridDefaults,
  create: async (input) => {
    const { createLayeredHybridMemoryModule } = await import("./layered-hybrid-plugin");
    return createLayeredHybridMemoryModule(input);
  },
}));