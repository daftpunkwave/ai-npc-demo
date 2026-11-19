/**
 * 定义世界模块拥有的 campaign、指标、角色、队伍、群体、委托、证据位置与章节统计状态。
 * 依赖 zod 与公共契约的领域值；所有状态只允许世界模块写入。
 * 禁止在这里执行 campaign 初始化、每日结算或任务规则。
 */
import { numericMeterIdSchema, resourceAmountsSchema, taskTypeSchema, watergateAllocationSchema } from "@ai-npc/contracts";
import { DomainError } from "@ai-npc/contracts";
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

export const campaignStateSchema = z
  .object({
    campaignId: z.string().min(1),
    factionId: z.string().min(1),
    playerId: z.string().min(1),
    chapterId: z.string().min(1),
    startTick: z.number().int().nonnegative(),
    status: z.enum(["running", "evaluated"]),
    outcome: z.enum(["equilibrium", "strained"]).nullable(),
  })
  .strict();

export const metersStateSchema = z
  .object({
    "relay.stability": z.number(),
    "orchard.water": z.number(),
    "migration.safety": z.number(),
    "watergate.allocation": watergateAllocationSchema,
    triggered: z.array(z.string()),
    lastDailyTick: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const characterStateSchema = z
  .object({
    agentId: z.string().min(1),
    factionId: z.string().min(1),
    nodeId: z.string().min(1),
    injuredUntilTick: z.number().int().nonnegative().nullable(),
    currentTaskId: z.string().min(1).nullable(),
  })
  .strict();

export const teamStateSchema = z
  .object({
    teamId: z.string().min(1),
    ownerFactionId: z.string().min(1),
    nodeId: z.string().min(1),
    capabilities: z.array(taskTypeSchema),
    capacity: z.number().int().positive(),
    status: z.enum(["idle", "assigned", "traveling", "working", "recovering"]),
    busyUntilTick: z.number().int().nonnegative().nullable(),
    currentTaskId: z.string().min(1).nullable(),
  })
  .strict();

export const groupStateSchema = z
  .object({
    groupId: z.string().min(1),
    nodeId: z.string().min(1),
    injured: z.number().int().nonnegative(),
    deadlineTick: z.number().int().nonnegative(),
    status: z.enum(["waiting", "rescued", "worsened"]),
    currentTaskId: z.string().min(1).nullable(),
  })
  .strict();

export const delegationStateSchema = z
  .object({
    delegationId: z.string().min(1),
    grantorFactionId: z.string().min(1),
    granteeId: z.string().min(1),
    teamIds: z.array(z.string().min(1)),
    // null 表示只委托队伍，不附带库存动用权。
    stockpileId: z.string().min(1).nullable(),
    remaining: resourceAmountsSchema,
    limit: resourceAmountsSchema,
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

export const evidencePlacementStateSchema = z
  .object({
    evidenceId: z.string().min(1),
    nodeId: z.string().min(1).nullable(),
    discoveredBy: z.string().min(1).nullable(),
  })
  .strict();

export const chapterStatsStateSchema = z
  .object({
    fulfilled: z.number().int().nonnegative(),
    breached: z.number().int().nonnegative(),
  })
  .strict();

export type CampaignState = z.infer<typeof campaignStateSchema>;
export type MetersState = z.infer<typeof metersStateSchema>;
export type CharacterState = z.infer<typeof characterStateSchema>;
export type TeamState = z.infer<typeof teamStateSchema>;
export type GroupState = z.infer<typeof groupStateSchema>;
export type DelegationState = z.infer<typeof delegationStateSchema>;
export type EvidencePlacementState = z.infer<typeof evidencePlacementStateSchema>;
export type ChapterStatsState = z.infer<typeof chapterStatsStateSchema>;

/** 指标 ID 的稳定顺序，用于未达标列表与变化数组。 */
export const numericMeterIds = numericMeterIdSchema.options;

/** 读取并校验世界聚合；缺失返回 null，损坏直接报错。 */
export function readWorldState<T>(
  tx: WorldTx,
  aggregateType: string,
  aggregateId: string,
  schema: z.ZodType<T>,
): { readonly version: number; readonly state: T } | null {
  const record = tx.get<unknown>(aggregateType, aggregateId);
  if (record === null) {
    return null;
  }
  const parsed = schema.safeParse(record.state);
  if (!parsed.success) {
    throw new DomainError("invalid-state", `世界聚合 ${aggregateType}:${aggregateId} 不合法`, {
      details: { aggregateType, aggregateId },
    });
  }
  return { version: record.version, state: parsed.data };
}
