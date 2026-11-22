/**
 * 定义命令类型目录、payload 查找表与命令请求判别联合。
 * 依赖领域值与命令载荷 schema；外层 commandId、expectedVersions 见命令信封。
 * 禁止在此执行命令或维护处理器注册表，处理模块由宿主装配。
 */
import { z } from "zod";
import { type Json } from "./json";
import { DomainError } from "./errors";
import {
  agreementProposePayloadSchema,
  agreementRespondPayloadSchema,
  campaignStartPayloadSchema,
  dialogueSayPayloadSchema,
  informationSharePayloadSchema,
  policySetPayloadSchema,
  probeAskPayloadSchema,
  scenarioCompensatePayloadSchema,
  scenarioDraftPayloadSchema,
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

/**
 * 命令目录的唯一登记表：键为命令类型，值为该命令的 payload schema。
 * 顺序与领域命令目录一致；命令类型、查找表与判别联合都由它派生，新增命令只改这里。
 */
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
  "scenario.draft": scenarioDraftPayloadSchema,
  "scenario.publish": scenarioPublishPayloadSchema,
  "scenario.withdraw": scenarioWithdrawPayloadSchema,
  "scenario.compensate": scenarioCompensatePayloadSchema,
  "scenario.override": scenarioOverridePayloadSchema,
  "probe.ask": probeAskPayloadSchema,
} as const;

/** 全部命令类型，直接由登记表键派生，避免目录与 schema 脱节。 */
export type CommandType = keyof typeof commandPayloadSchemas;

export const commandTypes = Object.keys(commandPayloadSchemas) as readonly CommandType[];

export const commandTypeSchema = z.enum(commandTypes as unknown as [CommandType, ...CommandType[]]);

/** 指定命令类型的 payload 数据形状。 */
export type CommandPayloadFor<T extends CommandType> = z.infer<(typeof commandPayloadSchemas)[T]>;

export type CommandPayload = z.infer<(typeof commandPayloadSchemas)[CommandType]>;

/** 已校验的命令请求：type 判别 payload，外层信封字段由 envelopes 负责。 */
export type CommandRequest = {
  [T in CommandType]: { readonly type: T; readonly payload: CommandPayloadFor<T> };
}[CommandType];

const commandRequestOptions = commandTypes.map((type) =>
  z.object({ type: z.literal(type), payload: commandPayloadSchemas[type] }).strict(),
);

export const commandRequestSchema: z.ZodType<CommandRequest> = z.union(
  commandRequestOptions,
) as unknown as z.ZodType<CommandRequest>;

/**
 * 按命令类型复验并收窄 payload：命令网关已用同一 schema 校验过入站载荷，
 * 规则处理器用本函数拿到的直接是推导类型，取代手写形状断言；形状不符抛 DomainError。
 */
export function commandPayloadOf<T extends CommandType>(type: T, payload: Json): CommandPayloadFor<T> {
  const result = commandPayloadSchemas[type].safeParse(payload);
  if (!result.success) {
    throw new DomainError("invalid-state", `命令 ${type} 的 payload 不符合契约`, {
      details: { issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
    });
  }
  return result.data as CommandPayloadFor<T>;
}
