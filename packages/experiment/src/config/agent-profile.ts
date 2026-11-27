/**
 * 加载并合并 Agent profile 继承链，校验槽位选择、预算和 run 级调度配置。
 * 依赖配置引用解析、YAML、Zod 与公共契约的 profile 字段 schema；产出公共契约的已解析 profile 形状。
 * 禁止读取代码实现、探测模型供应商或静默补上未声明的槽位。
 */
import { z } from "zod";
import {
  agentModuleSelectionSchema,
  agentProfileBudgetsSchema,
  agentProfileReadinessSchema,
  agentProfileSchedulingSchema,
  agentSlots,
  type AgentSlot,
  type Json,
  type ResolvedAgentProfile,
} from "@world-prism/contracts";
import { crossCheckLoadingError, referenceLoadingError } from "../loading/errors";
import { loadConfigDocument, type ConfigLoadContext, type LoadedConfig } from "./load-config";

const slotsSchema = z
  .object(
    Object.fromEntries(agentSlots.map((slot) => [slot, agentModuleSelectionSchema.optional()])) as Record<
      AgentSlot,
      z.ZodOptional<typeof agentModuleSelectionSchema>
    >,
  )
  .strict();

const profileDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: z.string().min(1),
    kind: z.enum(["platform", "scene", "agent", "variant"]),
    // variant 常被单独引用为 patch，可以不带父 profile；其余 kind 必须显式给出 parent 或 null，
    // 避免继承链起点被省略成隐式默认值。
    parent: z.string().min(1).nullable().optional(),
    budgets: agentProfileBudgetsSchema.optional(),
    readiness: agentProfileReadinessSchema.optional(),
    speech: z.object({ maxChars: z.number().int().positive() }).strict().optional(),
    failurePolicy: z.enum(["strict", "online-fallback"]).optional(),
    scheduling: agentProfileSchedulingSchema.optional(),
    slots: slotsSchema.optional(),
    patch:
      z
        .object({
          budgets: agentProfileBudgetsSchema.optional(),
          readiness: agentProfileReadinessSchema.optional(),
          speech: z.object({ maxChars: z.number().int().positive() }).strict().optional(),
          failurePolicy: z.enum(["strict", "online-fallback"]).optional(),
          scheduling: agentProfileSchedulingSchema.optional(),
          slots: slotsSchema.optional(),
        })
        .strict()
        .optional(),
  })
  .strict()
  .superRefine((document, context) => {
    // patch 只对 variant 有意义：其他 kind 声明 patch 时自身 slots 与预算会被静默丢弃。
    if (document.patch !== undefined && document.kind !== "variant") {
      context.addIssue({
        code: "custom",
        path: ["patch"],
        message: `只有 variant 允许声明 patch，${document.kind} 请直接写顶层字段`,
      });
    }
    // 只有 variant 可以省略 parent：其余 kind 必须显式写 parent 或 null，继承链起点不靠省略表达。
    if (document.parent === undefined && document.kind !== "variant") {
      context.addIssue({
        code: "custom",
        path: ["parent"],
        message: `只有 variant 允许省略 parent，${document.kind} 必须显式写 parent 或 null`,
      });
    }
  });

export type AgentProfileDocument = z.infer<typeof profileDocumentSchema>;

function loadDocument(
  configRef: string,
  context: ConfigLoadContext,
): LoadedConfig<AgentProfileDocument> {
  const loaded = loadConfigDocument(configRef, profileDocumentSchema, context, "profile");
  if (loaded.value.profileId !== configRef) {
    throw referenceLoadingError(
      loaded.source,
      "profileId",
      `profileId「${loaded.value.profileId}」与引用「${configRef}」不一致`,
    );
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
    throw referenceLoadingError(
      configRef,
      "parent",
      `Agent profile 继承链存在环：${[...active, configRef].join(" -> ")}`,
    );
  }
  active.add(configRef);
  const loaded = loadDocument(configRef, context);
  // variant 可省略 parent；其余 kind 经 schema 保证字段存在，缺省与 null 都表示继承链起点。
  const parentRef = loaded.value.parent ?? null;
  const parent = parentRef === null
    ? null
    : chainDocuments(parentRef, context, active);
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
    throw crossCheckLoadingError(
      `profile:${configRef}`,
      "budgets",
      `Agent profile「${configRef}」缺少预算、就绪、对白、失败策略或调度配置`,
    );
  }
  for (const slot of ["perception", "memory", "context", "compression", "toolView", "decision"] as const) {
    if (value.slots?.[slot] === undefined) {
      throw crossCheckLoadingError(
        `profile:${configRef}`,
        `slots.${slot}`,
        `Agent profile「${configRef}」缺少必需槽位 ${slot}`,
      );
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
    throw crossCheckLoadingError(
      loaded.source,
      "kind",
      `profile patch「${patchRef}」必须是带 patch 的 variant`,
    );
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
      throw crossCheckLoadingError(
        `profile:${profile.profileId}`,
        `slots.${slot}`,
        `profile「${profile.profileId}」缺少槽位 ${slot}`,
      );
    }
    if (!(slots[slot] ?? []).includes(selected.module)) {
      throw crossCheckLoadingError(
        `profile:${profile.profileId}`,
        `slots.${slot}.module`,
        `profile「${profile.profileId}」的 ${slot} 选择了未装配模块 ${selected.module}`,
      );
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
