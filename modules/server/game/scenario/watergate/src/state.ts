/**
 * 定义剧情卡与剧情运行状态：卡片发布/触发状态、升级版修复记录与调试覆盖的污染记录。
 * 依赖 zod 与公共契约的剧情卡效果 schema；只做状态校验与读取。
 * 禁止在这里执行卡片效果、计算触发 tick 或裁决命令。
 */
import { cardEffectSchema, overrideEffectSchema, scenarioCardStatusSchema } from "@ai-npc/contracts";
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

const cardEffectListSchema = z.array(cardEffectSchema);

export const scenarioCardStateSchema = z
  .object({
    cardId: z.string().min(1),
    version: z.number().int().positive(),
    status: scenarioCardStatusSchema,
    triggerAtTick: z.number().int().nonnegative(),
    effects: cardEffectListSchema,
    note: z.string(),
  })
  .strict();

/** 一次调试覆盖的污染来源；effects 保留当时生效的覆盖效果快照，便于重启后追溯。 */
export const scenarioContaminationSchema = z
  .object({
    source: z.literal("scenario.override"),
    note: z.string().min(1),
    tick: z.number().int().nonnegative(),
    effects: z.array(overrideEffectSchema).min(1),
  })
  .strict();

/** 运行状态：既有节奏标记，以及“是否被调试覆盖污染”的持久记录；旧记录缺省为未污染。 */
export const scenarioRunStateSchema = z
  .object({
    scenarioId: z.string().min(1),
    repairCompleted: z.boolean(),
    alarmTriggered: z.boolean(),
    contaminated: z.boolean().default(false),
    contaminations: z.array(scenarioContaminationSchema).default([]),
  })
  .strict();

export type ScenarioCardState = z.infer<typeof scenarioCardStateSchema>;
export type ScenarioContamination = z.infer<typeof scenarioContaminationSchema>;
export type ScenarioRunState = z.infer<typeof scenarioRunStateSchema>;

/** 读取并校验卡片状态；缺失返回 null。 */
export function readCardState(tx: WorldTx, cardId: string): ScenarioCardState | null {
  const record = tx.get<unknown>("scenario-card", cardId);
  if (record === null) {
    return null;
  }
  const parsed = scenarioCardStateSchema.safeParse(record.state);
  if (!parsed.success) {
    throw new Error(`剧情卡 ${cardId} 状态不合法`);
  }
  return parsed.data;
}

/** 读取并校验运行状态；缺失返回 null。 */
export function readRunState(tx: WorldTx, scenarioId: string): ScenarioRunState | null {
  const record = tx.get<unknown>("scenario-run", scenarioId);
  if (record === null) {
    return null;
  }
  const parsed = scenarioRunStateSchema.safeParse(record.state);
  if (!parsed.success) {
    throw new Error(`剧情运行 ${scenarioId} 状态不合法`);
  }
  return parsed.data;
}
