/**
 * 定义领域命令目录中每种命令的 payload schema。
 * 依赖领域值 schema、ID、原因码与协议条款；信封字段由 envelopes 负责。
 * 禁止在此做权限、暂停、版本或业务规则校验，这些属于命令网关与规则处理器。
 */
import { z } from "zod";
import { contentIdSchemas, idSchemas, principalIdSchema } from "./ids";
import { reasonCodeSchema } from "./reason-codes";
import {
  cardEffectSchema,
  dialogueIntentKindSchema,
  escortTaskParamsSchema,
  overrideEffectSchema,
  repairTaskParamsSchema,
  rescueTaskParamsSchema,
  scoutTaskParamsSchema,
  speechChannelSchema,
  termSchema,
  transportTaskParamsSchema,
} from "./command-values";

export const campaignStartPayloadSchema = z
  .object({
    factionId: z.string().min(1),
  })
  .strict();

export const dialogueSayPayloadSchema = z
  .object({
    targetAgentId: principalIdSchema,
    text: z.string().min(1).max(300),
  })
  .strict();

export const speechCommitPayloadSchema = z
  .object({
    channel: speechChannelSchema,
    conversationId: idSchemas.conv.nullable(),
    audience: z.array(principalIdSchema).min(1),
    approvedSpeechArtifactRef: idSchemas.art,
    intentKind: dialogueIntentKindSchema,
    replyToId: idSchemas.dlg.nullable(),
  })
  .strict();

export const seatSayPayloadSchema = z
  .object({
    to: z.array(principalIdSchema).min(1),
    text: z.string().min(1).max(200),
  })
  .strict();

export const informationSharePayloadSchema = z
  .object({
    evidenceId: contentIdSchemas.ev,
    audience: z.array(principalIdSchema).min(1),
  })
  .strict();

export const agreementProposePayloadSchema = z
  .object({
    parties: z.array(principalIdSchema).min(2),
    terms: z.array(termSchema).min(1),
    expiresInTicks: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (new Set(proposal.parties).size !== proposal.parties.length) {
      context.addIssue({ code: "custom", message: "协议当事人不能重复", path: ["parties"] });
    }
  });

export const agreementRespondPayloadSchema = z
  .object({
    agreementId: idSchemas.agr,
    response: z.enum(["accept", "reject", "counter"]),
    counterTerms: z.array(termSchema).min(1).optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.response === "counter" && response.counterTerms === undefined) {
      context.addIssue({ code: "custom", message: "还价必须提供新条款", path: ["counterTerms"] });
    }
    if (response.response !== "counter" && response.counterTerms !== undefined) {
      context.addIssue({ code: "custom", message: "只有还价可以携带新条款", path: ["counterTerms"] });
    }
  });

const dispatchCommonShape = {
  teamId: contentIdSchemas.team,
  invitees: z.array(principalIdSchema).optional(),
  departAfterTicks: z.number().int().min(1).max(6).optional(),
};

/** 派遣命令按 taskType 判别，params 与任务类型一一对应。 */
export const taskDispatchPayloadSchema = z.discriminatedUnion("taskType", [
  z.object({ taskType: z.literal("transport"), ...dispatchCommonShape, params: transportTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("escort"), ...dispatchCommonShape, params: escortTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("rescue"), ...dispatchCommonShape, params: rescueTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("repair"), ...dispatchCommonShape, params: repairTaskParamsSchema }).strict(),
  z.object({ taskType: z.literal("scout"), ...dispatchCommonShape, params: scoutTaskParamsSchema }).strict(),
]);

export type TaskDispatchPayload = z.infer<typeof taskDispatchPayloadSchema>;

export const taskRespondPayloadSchema = z
  .object({
    taskId: idSchemas.task,
    response: z.enum(["accept", "decline"]),
    reasonCode: reasonCodeSchema.optional(),
  })
  .strict();

export const taskCancelPayloadSchema = z
  .object({
    taskId: idSchemas.task,
  })
  .strict();

export const policySetPayloadSchema = z
  .object({
    key: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

export const scenarioPublishPayloadSchema = z
  .object({
    cardId: contentIdSchemas.card,
    version: z.number().int().positive(),
    triggerAtTick: z.number().int().nonnegative(),
  })
  .strict();

export const scenarioWithdrawPayloadSchema = z
  .object({
    cardId: contentIdSchemas.card,
  })
  .strict();

export const scenarioCompensatePayloadSchema = z
  .object({
    cardId: contentIdSchemas.card,
    effects: z.array(cardEffectSchema).min(1),
    note: z.string().min(1),
  })
  .strict();

export const scenarioOverridePayloadSchema = z
  .object({
    effects: z.array(overrideEffectSchema).min(1),
    note: z.string().min(1),
  })
  .strict();

export const probeAskPayloadSchema = z
  .object({
    probeId: idSchemas.prb,
    agentId: principalIdSchema,
    askedBy: principalIdSchema,
    question: z.string().min(1),
  })
  .strict();
