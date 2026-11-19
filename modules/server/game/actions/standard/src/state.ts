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

/** 实际扣减过的委托记录；回补按这里的委托 ID 进行，不再按主体与库存点重新查找。 */
const delegationDrawSchema = z
  .object({
    delegationId: z.string().min(1),
    stockpileId: z.string().min(1),
    amount: resourceAmountsSchema,
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
    /** 实际扣减的委托余额；只有委托身份动用库存点时才有记录，旧任务行按空数组补齐。 */
    delegationDraws: z.array(delegationDrawSchema).default([]),
    patrolStartTick: z.number().int().nonnegative().nullable(),
    patrolEndTick: z.number().int().nonnegative().nullable(),
    workStartTick: z.number().int().nonnegative().nullable(),
    workNodeId: z.string().min(1).nullable(),
    /** 出发时抽样的风险结果；旧任务行没有该字段时按无延误、无伤势补齐。 */
    riskOutcome: riskOutcomeSchema.default({ delayTicks: 0, injuredAgentIds: [], teamInjured: false }),
    delayNoticeSent: z.boolean(),
    /** 修复材料已结算标记：完成与工作中取消共用同一幂等结算；旧任务行没有该字段时按未结算补齐。 */
    materialsConsumed: z.boolean().default(false),
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
export type DelegationDraw = z.infer<typeof delegationDrawSchema>;
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
