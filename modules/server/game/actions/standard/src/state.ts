/**
 * 定义行动模块拥有的任务与邀请聚合状态。
 * 依赖公共契约的资源量与任务类型；只做状态校验与读取。
 * 禁止在这里执行派遣校验、路线计算或风险抽样。
 */
import { DomainError, jsonValueSchema, resourceAmountsSchema, taskTypeSchema } from "@ai-npc/contracts";
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

/** 出发时抽样得到的内部风险：只写进任务状态，完成时才应用伤势并公布。 */
const riskOutcomeSchema = z
  .object({
    delayTicks: z.number().int().nonnegative(),
    injuredAgentIds: z.array(z.string().min(1)),
    teamInjured: z.boolean(),
  })
  .strict();

export const taskStateSchema = z
  .object({
    taskId: z.string().min(1),
    taskType: taskTypeSchema,
    teamId: z.string().min(1),
    dispatcherId: z.string().min(1),
    invitees: z.array(z.string().min(1)),
    participants: z.array(z.string().min(1)),
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    params: jsonValueSchema,
    route: z.array(z.string().min(1)),
    departTick: z.number().int().nonnegative(),
    nominalCompletionTick: z.number().int().nonnegative(),
    completedAtTick: z.number().int().nonnegative().nullable(),
    phase: z.enum(["pending", "traveling", "working"]),
    reserved: resourceAmountsSchema,
    fromStockpileId: z.string().min(1).nullable(),
    toStockpileId: z.string().min(1).nullable(),
    patrolStartTick: z.number().int().nonnegative().nullable(),
    patrolEndTick: z.number().int().nonnegative().nullable(),
    workStartTick: z.number().int().nonnegative().nullable(),
    workNodeId: z.string().min(1).nullable(),
    riskOutcome: riskOutcomeSchema,
    delayNoticeSent: z.boolean(),
    /** 修复材料已结算标记：完成与工作中取消共用同一幂等结算。 */
    materialsConsumed: z.boolean(),
    failureReason: z.string().min(1).nullable(),
    canceledAtTick: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const invitationStateSchema = z
  .object({
    invitationId: z.string().min(1),
    taskId: z.string().min(1),
    inviteeId: z.string().min(1),
    response: z.enum(["pending", "accept", "decline", "expired"]),
    reasonCode: z.string().min(1).nullable(),
  })
  .strict();

export type TaskState = z.infer<typeof taskStateSchema>;
export type InvitationState = z.infer<typeof invitationStateSchema>;

/** 读取并校验任务聚合；缺失返回 null，损坏直接报错。 */
export function readTaskState(tx: WorldTx, taskId: string): TaskState | null {
  return readActionState(tx, "task", taskId, taskStateSchema);
}

/** 读取并校验邀请聚合；缺失返回 null。 */
export function readInvitationState(tx: WorldTx, invitationId: string): InvitationState | null {
  return readActionState(tx, "task-invitation", invitationId, invitationStateSchema);
}

/** 读取并校验任务或邀请聚合；缺失返回 null，损坏直接报错。 */
export function readActionState<T>(
  tx: WorldTx,
  aggregateType: string,
  aggregateId: string,
  schema: z.ZodType<T>,
): T | null {
  const record = tx.get<unknown>(aggregateType, aggregateId);
  if (record === null) {
    return null;
  }
  const parsed = schema.safeParse(record.state);
  if (!parsed.success) {
    throw new DomainError("invalid-state", `行动聚合 ${aggregateType}:${aggregateId} 不合法`, {
      details: { aggregateType, aggregateId },
    });
  }
  return parsed.data;
}
