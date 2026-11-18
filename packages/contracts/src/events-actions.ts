/**
 * 定义任务、资源与任务邀请相关事件的 payload schema。
 * 依赖领域值 schema、ID 与原因码；信封与受众由宿主另行补充。
 * 禁止在此执行任务校验或风险抽样，payload 只记录已结算的公开结果。
 */
import { z } from "zod";
import { contentIdSchemas, idSchemas, principalIdSchema } from "./ids";
import { reasonCodeSchema } from "./reason-codes";
import {
  escortTaskParamsSchema,
  repairTaskParamsSchema,
  rescueTaskParamsSchema,
  resourceAmountsSchema,
  resourceDeltaSchema,
  scoutTaskParamsSchema,
  taskTypeSchema,
  transportTaskParamsSchema,
} from "./command-values";

const dispatchedCommonShape = {
  taskId: idSchemas.task,
  teamId: contentIdSchemas.team,
  dispatcherId: principalIdSchema,
  invitees: z.array(principalIdSchema),
  departTick: z.number().int().nonnegative(),
};

/** 已派遣任务按 taskType 判别，params 与任务类型一一对应。 */
export const taskDispatchedPayloadSchema = z.discriminatedUnion("taskType", [
  z.object({ taskType: z.literal("transport"), ...dispatchedCommonShape, params: transportTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("escort"), ...dispatchedCommonShape, params: escortTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("rescue"), ...dispatchedCommonShape, params: rescueTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("repair"), ...dispatchedCommonShape, params: repairTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("scout"), ...dispatchedCommonShape, params: scoutTaskParamsSchema }).strict(),
]);

export type TaskDispatchedPayload = z.infer<typeof taskDispatchedPayloadSchema>;

/** 预留与释放共用载荷，delta 为三个资源的完整数量。 */
export const resourcesReservedPayloadSchema = z
  .object({
    stockpileId: contentIdSchemas.sp,
    delta: resourceAmountsSchema,
    taskId: idSchemas.task,
  })
  .strict();

export const taskInvitationIssuedPayloadSchema = z
  .object({
    invitationId: idSchemas.inv,
    taskId: idSchemas.task,
    inviteeId: principalIdSchema,
    taskType: taskTypeSchema,
    departTick: z.number().int().nonnegative(),
  })
  .strict();

/** 邀请回应与过期共用载荷；过期时 response 与 reasonCode 为 null。 */
export const taskInvitationOutcomePayloadSchema = z
  .object({
    invitationId: idSchemas.inv,
    taskId: idSchemas.task,
    inviteeId: principalIdSchema,
    response: z.enum(["accept", "decline"]).nullable(),
    reasonCode: reasonCodeSchema.nullable(),
  })
  .strict();

export const taskDepartedPayloadSchema = z
  .object({
    taskId: idSchemas.task,
    participants: z.array(principalIdSchema),
    route: z.array(contentIdSchemas.r).min(1),
    nominalCompletionTick: z.number().int().nonnegative(),
  })
  .strict();

export const taskDelayedPayloadSchema = z
  .object({
    taskId: idSchemas.task,
    newCompletionTick: z.number().int().nonnegative(),
    cause: z.literal("road-risk"),
  })
  .strict();

/** 任务完成效果依结算顺序排列，至少包含任务本身一项。 */
export const taskEffectSchema = z
  .object({
    kind: taskTypeSchema,
  })
  .strict();

export type TaskEffect = z.infer<typeof taskEffectSchema>;

export const taskCompletedPayloadSchema = z
  .object({
    taskId: idSchemas.task,
    taskType: taskTypeSchema,
    completedAtTick: z.number().int().nonnegative(),
    effects: z.array(taskEffectSchema).min(1),
  })
  .strict();

export const taskFailedPayloadSchema = z
  .object({
    taskId: idSchemas.task,
    reasonCode: reasonCodeSchema,
  })
  .strict();

export const taskCancelledPayloadSchema = z
  .object({
    taskId: idSchemas.task,
    byId: principalIdSchema,
  })
  .strict();

export const resourcesTransferredPayloadSchema = z
  .object({
    fromStockpileId: contentIdSchemas.sp,
    toStockpileId: contentIdSchemas.sp,
    delta: resourceAmountsSchema,
    taskId: idSchemas.task,
    dispatcherId: principalIdSchema,
  })
  .strict();

export const resourcesConsumedPayloadSchema = z
  .object({
    stockpileId: contentIdSchemas.sp,
    delta: resourceAmountsSchema,
    reason: z.string().min(1),
    taskId: idSchemas.task.nullable(),
  })
  .strict();

export const stockpileAdjustedPayloadSchema = z
  .object({
    stockpileId: contentIdSchemas.sp,
    delta: resourceDeltaSchema,
    reason: z.string().min(1),
  })
  .strict();
