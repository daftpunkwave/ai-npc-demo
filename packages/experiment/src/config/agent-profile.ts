/**
 * 加载并合并 Agent profile 继承链，校验槽位选择、预算和 run 级调度配置。
 * 依赖配置引用解析、YAML、Zod 与公共模块枚举。
 * 禁止读取代码实现、探测模型供应商或静默补上未声明的槽位。
 */
import { z } from "zod";
import {
  agentSlots,
  jsonValueSchema,
  moduleIdSchema,
  type AgentSlot,
  type Json,
} from "@ai-npc/contracts";
import { loadConfigDocument, type ConfigLoadContext, type LoadedConfig } from "./load-config";

const moduleSelectionSchema = z
  .object({
    module: moduleIdSchema,
    config: jsonValueSchema,
  })
  .strict();

const budgetSchema = z
  .object({
    maxModelCallsPerTurn: z.number().int().positive(),
    maxDecisionRounds: z.number().int().positive(),
    maxToolCallsPerTurn: z.number().int().positive(),
    maxToolCallsPerRound: z.number().int().positive(),
    maxTurnMs: z.number().int().positive(),
    maxReplans: z.number().int().nonnegative(),
    maxTokensPerAgentPerDay: z.number().int().nonnegative(),
    reserveOutputTokens: z
      .object({
        decision: z.number().int().positive(),
        speech: z.number().int().positive(),
        "memory-maintenance": z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const readinessSchema = z
  .object({
    requireDurable: z.boolean(),
    requireDerived: z.boolean(),
    waitTimeoutMs: z.number().int().positive(),
    onlineDegradeAfterMs: z.number().int().nonnegative(),
  })
  .strict();

const schedulingSchema = z
  .object({
    module: moduleIdSchema,
    config: jsonValueSchema,
  })
  .strict();

const slotsSchema = z
  .object(
    Object.fromEntries(agentSlots.map((slot) => [slot, moduleSelectionSchema.optional()])) as Record<
      AgentSlot,
      z.ZodOptional<typeof moduleSelectionSchema>
    >,
  )
  .strict();

const profileDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().min(1),
    kind: z.enum(["platform", "scene", "agent", "variant"]),
    parent: z.string().min(1).nullable(),
    budgets: budgetSchema.optional(),
    readiness: readinessSchema.optional(),
    speech: z.object({ maxChars: z.number().int().positive() }).strict().optional(),
    failurePolicy: z.enum(["strict", "online-fallback"]).optional(),
    scheduling: schedulingSchema.optional(),
    slots: slotsSchema.optional(),
    patch:
      z
        .object({
          budgets: budgetSchema.optional(),
          readiness: readinessSchema.optional(),
          speech: z.object({ maxChars: z.number().int().positive() }).strict().optional(),
          failurePolicy: z.enum(["strict", "online-fallback"]).optional(),
          scheduling: schedulingSchema.optional(),
          slots: slotsSchema.optional(),
        })
        .strict()
        .optional(),
  })
  .strict();

export type AgentProfileDocument = z.infer<typeof profileDocumentSchema>;
export type AgentModuleSelection = z.infer<typeof moduleSelectionSchema>;

export interface ResolvedAgentProfile {
  readonly profileId: string;
  readonly sourceChain: readonly string[];
  readonly budgets: z.infer<typeof budgetSchema>;
  readonly readiness: z.infer<typeof readinessSchema>;
  readonly speech: { readonly maxChars: number };
  readonly failurePolicy: "strict" | "online-fallback";
  readonly scheduling: z.infer<typeof schedulingSchema>;
  readonly slots: Readonly<Partial<Record<AgentSlot, AgentModuleSelection>>>;
}

function loadDocument(
  configRef: string,
  context: ConfigLoadContext,
): LoadedConfig<AgentProfileDocument> {
  const loaded = loadConfigDocument(configRef, profileDocumentSchema, context, "profile");
  if (loaded.value.profileId !== configRef) {
    throw new Error(`profileId「${loaded.value.profileId}」与引用「${configRef}」不一致`);
  }
  return loaded;
}

function applyPatch(
  current: AgentProfileDocument,
  patch: AgentProfileDocument,
): AgentProfileDocument {
  const next = patch.patch ?? patch;
  const slots = { ...current.slots };
  for (const slot of agentSlots) {
    const selected = next.slots?.[slot];
    if (selected !== undefined) {
      slots[slot] = selected;
    }
  }
  return {
    ...current,
    ...(next.budgets === undefined ? {} : { budgets: next.budgets }),
    ...(next.readiness === undefined ? {} : { readiness: next.readiness }),
    ...(next.speech === undefined ? {} : { speech: next.speech }),
    ...(next.failurePolicy === undefined ? {} : { failurePolicy: next.failurePolicy }),
    ...(next.scheduling === undefined ? {} : { scheduling: next.scheduling }),
    slots,
    patch: undefined,
  };
}

function chainDocuments(
  configRef: string,
  context: ConfigLoadContext,
  active: Set<string>,
): {
  readonly sourceChain: readonly string[];
  readonly value: AgentProfileDocument;
} {
  if (active.has(configRef)) {
    throw new Error(`Agent profile 继承链存在环：${[...active, configRef].join(" -> ")}`);
  }
  active.add(configRef);
  const loaded = loadDocument(configRef, context);
  const parent = loaded.value.parent === null
    ? null
    : chainDocuments(loaded.value.parent, context, active);
  active.delete(configRef);
  if (parent === null) {
    return { sourceChain: [loaded.source], value: loaded.value };
  }
  return {
    sourceChain: [...parent.sourceChain, loaded.source],
    value: applyPatch(parent.value, loaded.value),
  };
}

/** 加载并解析 profile；六个 Agent 槽位都必须由继承链提供。 */
export function loadAgentProfile(
  configRef: string,
  context: ConfigLoadContext,
): ResolvedAgentProfile {
  const chain = chainDocuments(configRef, context, new Set());
  const value = chain.value;
  if (
    value.budgets === undefined ||
    value.readiness === undefined ||
    value.speech === undefined ||
    value.failurePolicy === undefined ||
    value.scheduling === undefined
  ) {
    throw new Error(`Agent profile「${configRef}」缺少预算、就绪、对白、失败策略或调度配置`);
  }
  for (const slot of ["perception", "memory", "context", "compression", "toolView", "decision"] as const) {
    if (value.slots?.[slot] === undefined) {
      throw new Error(`Agent profile「${configRef}」缺少必需槽位 ${slot}`);
    }
  }
  return {
    profileId: configRef,
    sourceChain: chain.sourceChain,
    budgets: value.budgets,
    readiness: value.readiness,
    speech: value.speech,
    failurePolicy: value.failurePolicy,
    scheduling: value.scheduling,
    slots: value.slots ?? {},
  };
}

/** 应用 variant patch；槽位整块替换，其他顶层键同样整块替换。 */
export function applyProfilePatch(
  profile: ResolvedAgentProfile,
  patchRef: string,
  context: ConfigLoadContext,
): ResolvedAgentProfile {
  const loaded = loadDocument(patchRef, context);
  if (loaded.value.kind !== "variant" || loaded.value.patch === undefined) {
    throw new Error(`profile patch「${patchRef}」必须是带 patch 的 variant`);
  }
  const baseDocument: AgentProfileDocument = {
    schemaVersion: 1,
    profileId: profile.profileId,
    kind: "agent",
    parent: null,
    budgets: profile.budgets,
    readiness: profile.readiness,
    speech: profile.speech,
    failurePolicy: profile.failurePolicy,
    scheduling: profile.scheduling,
    slots: profile.slots,
  };
  const merged = applyPatch(baseDocument, loaded.value);
  return {
    ...profile,
    budgets: merged.budgets ?? profile.budgets,
    readiness: merged.readiness ?? profile.readiness,
    speech: merged.speech ?? profile.speech,
    failurePolicy: merged.failurePolicy ?? profile.failurePolicy,
    scheduling: merged.scheduling ?? profile.scheduling,
    slots: merged.slots ?? profile.slots,
    sourceChain: [...profile.sourceChain, loaded.source],
  };
}

/** profile 选择只能落在装配声明的槽位白名单内。 */
export function validateProfileSelection(
  profile: ResolvedAgentProfile,
  slots: Readonly<Partial<Record<AgentSlot, readonly string[]>>>,
): void {
  for (const slot of agentSlots) {
    const selected = profile.slots[slot];
    if (selected === undefined) {
      throw new Error(`profile「${profile.profileId}」缺少槽位 ${slot}`);
    }
    if (!(slots[slot] ?? []).includes(selected.module)) {
      throw new Error(`profile「${profile.profileId}」的 ${slot} 选择了未装配模块 ${selected.module}`);
    }
  }
}

/** 供摘要计算的稳定 profile 视图。 */
export function profileJson(profile: ResolvedAgentProfile): Json {
  return {
    profileId: profile.profileId,
    budgets: profile.budgets,
    readiness: profile.readiness,
    speech: profile.speech,
    failurePolicy: profile.failurePolicy,
    scheduling: profile.scheduling,
    slots: profile.slots as unknown as Json,
  };
}
