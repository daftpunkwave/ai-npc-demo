/**
 * 定义事件信封、命令信封、提交回执与认证上下文。
 * 依赖受众、原因码、ID 与 JSON schema；主体身份只能由宿主构造，不能来自 payload。
 * 禁止在此执行权限判断、生成 receipt 或把回执与异步任务状态合并为一个 status。
 */
import { z } from "zod";
import { audienceSpecSchema } from "./audience";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";
import { reasonCodeSchema } from "./reason-codes";

/** 主体类型：玩家、Agent、控制台三类角色与系统。 */
export const principalKindSchema = z.enum(["player", "agent", "operator", "researcher", "evaluator", "system"]);

export type PrincipalKind = z.infer<typeof principalKindSchema>;

/** 会话角色，控制台请求另以当前激活角色鉴权。 */
export const sessionRoleSchema = z.enum(["player", "operator", "researcher", "evaluator"]);

export type SessionRole = z.infer<typeof sessionRoleSchema>;

/**
 * 认证上下文：总是由宿主根据会话与席位租约构造。
 * controllerEpoch 在 Agent 身份或真人代发时非空，turnLeaseEpoch 在 turn 内命令时非空；
 * 这两项由命令网关按允许直连测试开关决定是否强制，schema 只校验形状。
 */
export const authContextSchema = z
  .object({
    principalId: principalIdSchema,
    kind: principalKindSchema,
    roles: z.array(z.string().min(1)),
    worldId: z.string().min(1),
    branchId: z.string().min(1),
    actingAsAgentId: principalIdSchema.nullable(),
    controllerEpoch: z.number().int().nonnegative().nullable(),
    turnLeaseEpoch: z.number().int().nonnegative().nullable(),
    turnId: idSchemas.turn.nullable(),
  })
  .strict();

export type AuthContext = z.infer<typeof authContextSchema>;

/** 事件信封：worldSeq 在分支内排序，审计与事件独立提交。 */
export const eventEnvelopeSchema = z
  .object({
    eventId: idSchemas.evt,
    schemaVersion: z.number().int().positive(),
    worldId: idSchemas.wld,
    branchId: idSchemas.br,
    worldSeq: z.number().int().nonnegative(),
    worldTick: z.number().int().nonnegative(),
    type: z.string().min(1),
    principalId: principalIdSchema,
    causationIds: z.array(z.string().min(1)),
    correlationId: z.string().min(1),
    audience: z.array(audienceSpecSchema),
    payload: jsonValueSchema,
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** 命令信封：commandId 由调用方生成并在重试时复用，expectedVersions 键为 “聚合类型:聚合 ID”。 */
export const commandEnvelopeSchema = z
  .object({
    commandId: idSchemas.cmd,
    type: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    expectedVersions: z.record(z.string().min(1), z.number().int().nonnegative()).optional(),
    payload: jsonValueSchema,
  })
  .strict();

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** 命令提交回执的不可变状态；accepted 不代表异步任务已完成。 */
export const commandStatusSchema = z.enum(["accepted", "rejected"]);

export type CommandStatus = z.infer<typeof commandStatusSchema>;

/** 异步任务投影状态，不能与 receipt 的 commandStatus 混用。 */
export const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** 工具执行状态：ok 可能是业务拒绝，unknown 表示副作用结果未确认。 */
export const executionStatusSchema = z.enum(["ok", "error", "unknown"]);

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

/**
 * 命令回执：幂等键与 payload 相同时返回原回执；accepted 时 reasonCode 必须为 null。
 * operationId 用于关联模型工具操作，result 携带如 taskId 或 agreementId 的结果。
 */
export const commandReceiptSchema = z
  .object({
    receiptId: idSchemas.rcp,
    commandId: idSchemas.cmd,
    commandStatus: commandStatusSchema,
    reasonCode: reasonCodeSchema.nullable(),
    safeMessage: z.string().nullable(),
    acceptedEventIds: z.array(idSchemas.evt),
    operationId: idSchemas.op.nullable(),
    resultingVersions: z.record(z.string().min(1), z.number().int().nonnegative()),
    result: jsonValueSchema.nullable(),
    worldTick: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.commandStatus === "accepted" && receipt.reasonCode !== null) {
      context.addIssue({
        code: "custom",
        message: "accepted 回执不能带原因码",
        path: ["reasonCode"],
      });
    }
    if (receipt.commandStatus === "rejected" && receipt.reasonCode === null) {
      context.addIssue({
        code: "custom",
        message: "rejected 回执必须带原因码",
        path: ["reasonCode"],
      });
    }
  });

export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
