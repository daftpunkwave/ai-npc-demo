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

/**
 * 命令载荷的统一输入上限。
 * 文本上限与对白正文 300 字对齐；主体名单上限覆盖内容角色、派系战略主体与玩家的并集
 * （共 17 个主体）并留出余量，避免一次命令派生出无界事件；协议条款上限 20，
 * 限制一次提案能安排的违约检查 job 数量。
 */
const maxCommandTextLength = 300;
const maxPrincipalListLength = 20;
const maxAgreementTermCount = 20;
/** 政策键是结构化的短键（如 `road.status:<roadId>`），不是自由文本。 */
const maxPolicyKeyLength = 120;

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
    audience: z.array(principalIdSchema).min(1).max(maxPrincipalListLength),
    approvedSpeechArtifactRef: idSchemas.art,
    intentKind: dialogueIntentKindSchema,
    replyToId: idSchemas.dlg.nullable(),
  })
  .strict();

/** 已通过契约校验的 speech.commit payload。 */
export type SpeechCommitPayload = z.infer<typeof speechCommitPayloadSchema>;

export const seatSayPayloadSchema = z
  .object({
    to: z.array(principalIdSchema).min(1).max(maxPrincipalListLength),
    text: z.string().min(1).max(200),
  })
  .strict();

/**
 * 公社党魁以玩家身份提交的公开广播正文。
 * 正文上限与对白一致；投递位置由服务端按玩家所在节点计算，不接受客户端自报。
 */
export const broadcastSayPayloadSchema = z
  .object({
    text: z.string().min(1).max(300),
  })
  .strict();

export const informationSharePayloadSchema = z
  .object({
    evidenceId: contentIdSchemas.ev,
    audience: z.array(principalIdSchema).min(1).max(maxPrincipalListLength),
  })
  .strict();

/**
 * 协议提案；`expiresInTicks` 未给出时默认 24，允许范围 1–168。
 * 超过上限由协议模块以 `deadline-out-of-range` 拒绝，不做静默钳制。
 */
export const agreementProposePayloadSchema = z
  .object({
    parties: z.array(principalIdSchema).min(2).max(maxPrincipalListLength),
    terms: z.array(termSchema).min(1).max(maxAgreementTermCount),
    expiresInTicks: z.number().int().positive().default(24),
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
    counterTerms: z.array(termSchema).min(1).max(maxAgreementTermCount).optional(),
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
    key: z.string().min(1).max(maxPolicyKeyLength),
    value: z.string().min(1),
  })
  .strict();

/** 道路状态政策键的固定前缀；政策键格式为 `road.status:<roadId>`。 */
export const roadStatusPolicyKeyPrefix = "road.status:";

/** 构造道路状态政策键；供 policy.set 与 PolicyChanged 事件使用同一格式。 */
export function roadStatusPolicyKey(roadId: string): string {
  return `${roadStatusPolicyKeyPrefix}${roadId}`;
}

/** 从政策键解析道路 ID；不是道路状态政策键时返回 null。 */
export function roadIdFromPolicyKey(key: string): string | null {
  return key.startsWith(roadStatusPolicyKeyPrefix)
    ? key.slice(roadStatusPolicyKeyPrefix.length)
    : null;
}

export const scenarioDraftPayloadSchema = z
  .object({
    cardId: contentIdSchemas.card,
    version: z.number().int().positive(),
    triggerAtTick: z.number().int().nonnegative(),
    effects: z.array(cardEffectSchema).min(1),
    note: z.string().min(1).max(maxCommandTextLength),
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
    note: z.string().min(1).max(maxCommandTextLength),
  })
  .strict();

export const scenarioOverridePayloadSchema = z
  .object({
    effects: z.array(overrideEffectSchema).min(1),
    note: z.string().min(1).max(maxCommandTextLength),
  })
  .strict();

export const probeAskPayloadSchema = z
  .object({
    probeId: idSchemas.prb,
    agentId: principalIdSchema,
    askedBy: principalIdSchema,
    question: z.string().min(1).max(maxCommandTextLength),
  })
  .strict();
