/**
 * 定义命令类型目录、payload 查找表与命令请求判别联合。
 * 依赖领域值与命令载荷 schema；外层 commandId、expectedVersions 见命令信封。
 * 禁止在此执行命令或维护处理器注册表，处理模块由宿主装配。
 */
import { z } from "zod";
import {
  agreementProposePayloadSchema,
  agreementRespondPayloadSchema,
  campaignStartPayloadSchema,
  dialogueSayPayloadSchema,
  informationSharePayloadSchema,
  policySetPayloadSchema,
  probeAskPayloadSchema,
  scenarioCompensatePayloadSchema,
  scenarioOverridePayloadSchema,
  scenarioPublishPayloadSchema,
  scenarioWithdrawPayloadSchema,
  seatSayPayloadSchema,
  speechCommitPayloadSchema,
  taskCancelPayloadSchema,
  taskDispatchPayloadSchema,
  taskRespondPayloadSchema,
} from "./command-payloads";

export * from "./command-values";
export * from "./command-payloads";

/** 全部命令类型，顺序与领域命令目录一致。 */
export const commandTypes = [
  "campaign.start",
  "dialogue.say",
  "speech.commit",
  "seat.say",
  "information.share",
  "agreement.propose",
  "agreement.respond",
  "task.dispatch",
  "task.respond",
  "task.cancel",
  "policy.set",
  "scenario.publish",
  "scenario.withdraw",
  "scenario.compensate",
  "scenario.override",
  "probe.ask",
] as const;

export type CommandType = (typeof commandTypes)[number];

export const commandTypeSchema = z.enum(commandTypes);

/** 命令类型到载荷 schema 的映射，供命令网关按 type 查 schema 校验。 */
export const commandPayloadSchemas = {
  "campaign.start": campaignStartPayloadSchema,
  "dialogue.say": dialogueSayPayloadSchema,
  "speech.commit": speechCommitPayloadSchema,
  "seat.say": seatSayPayloadSchema,
  "information.share": informationSharePayloadSchema,
  "agreement.propose": agreementProposePayloadSchema,
  "agreement.respond": agreementRespondPayloadSchema,
  "task.dispatch": taskDispatchPayloadSchema,
  "task.respond": taskRespondPayloadSchema,
  "task.cancel": taskCancelPayloadSchema,
  "policy.set": policySetPayloadSchema,
  "scenario.publish": scenarioPublishPayloadSchema,
  "scenario.withdraw": scenarioWithdrawPayloadSchema,
  "scenario.compensate": scenarioCompensatePayloadSchema,
  "scenario.override": scenarioOverridePayloadSchema,
  "probe.ask": probeAskPayloadSchema,
} as const;

export type CommandPayload = z.infer<(typeof commandPayloadSchemas)[CommandType]>;

export type CommandPayloadFor<T extends CommandType> = z.infer<(typeof commandPayloadSchemas)[T]>;

/** 已校验的命令请求：type 判别 payload，外层信封字段由 envelopes 负责。 */
export const commandRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("campaign.start"), payload: campaignStartPayloadSchema }).strict(),
  z.object({ type: z.literal("dialogue.say"), payload: dialogueSayPayloadSchema }).strict(),
  z.object({ type: z.literal("speech.commit"), payload: speechCommitPayloadSchema }).strict(),
  z.object({ type: z.literal("seat.say"), payload: seatSayPayloadSchema }).strict(),
  z.object({ type: z.literal("information.share"), payload: informationSharePayloadSchema }).strict(),
  z.object({ type: z.literal("agreement.propose"), payload: agreementProposePayloadSchema }).strict(),
  z.object({ type: z.literal("agreement.respond"), payload: agreementRespondPayloadSchema }).strict(),
  z.object({ type: z.literal("task.dispatch"), payload: taskDispatchPayloadSchema }).strict(),
  z.object({ type: z.literal("task.respond"), payload: taskRespondPayloadSchema }).strict(),
  z.object({ type: z.literal("task.cancel"), payload: taskCancelPayloadSchema }).strict(),
  z.object({ type: z.literal("policy.set"), payload: policySetPayloadSchema }).strict(),
  z.object({ type: z.literal("scenario.publish"), payload: scenarioPublishPayloadSchema }).strict(),
  z.object({ type: z.literal("scenario.withdraw"), payload: scenarioWithdrawPayloadSchema }).strict(),
  z.object({ type: z.literal("scenario.compensate"), payload: scenarioCompensatePayloadSchema }).strict(),
  z.object({ type: z.literal("scenario.override"), payload: scenarioOverridePayloadSchema }).strict(),
  z.object({ type: z.literal("probe.ask"), payload: probeAskPayloadSchema }).strict(),
]);

export type CommandRequest = z.infer<typeof commandRequestSchema>;
