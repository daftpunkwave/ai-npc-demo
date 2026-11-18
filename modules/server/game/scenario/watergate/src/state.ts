/**
 * 定义剧情卡与剧情运行状态：卡片发布/触发状态和升级版修复记录。
 * 依赖 zod；只做状态校验与读取。
 * 禁止在这里执行卡片效果或计算触发 tick。
 */
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

export const scenarioCardStateSchema = z
  .object({
    cardId: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(["draft", "published", "triggered", "withdrawn"]),
    triggerAtTick: z.number().int().nonnegative(),
    note: z.string(),
  })
  .strict();

export const scenarioRunStateSchema = z
  .object({
    scenarioId: z.string().min(1),
    repairCompleted: z.boolean(),
    alarmTriggered: z.boolean(),
  })
  .strict();

export type ScenarioCardState = z.infer<typeof scenarioCardStateSchema>;
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
