/**
 * 定义命令 receipt 与任务结果可使用的全部原因码，按用途分组保留。
 * 只依赖 zod；原因码是业务拒绝的分类，与统一错误码不是同一套枚举。
 * 禁止在此新增未登记的码，未知拒绝原因必须回到契约层解决。
 */
import { z } from "zod";

/** 原因码分组：通用、通信、协议、任务、政策与剧情、Agent 拒绝理由。 */
export const reasonCodeGroups = {
  common: [
    "invalid-params",
    "unknown-target",
    "no-authority",
    "paused",
    "not-ready",
    "idempotency-conflict",
    "version-conflict",
    "stale-controller",
    "stale-turn",
    "budget-exhausted",
  ],
  communication: ["relay-down", "speech-not-approved", "evidence-not-held", "secret-not-shareable"],
  agreement: [
    "invalid-terms",
    "obligor-not-party",
    "deadline-out-of-range",
    "not-a-party",
    "agreement-not-open",
    "already-responded",
  ],
  task: [
    "team-busy",
    "capability-missing",
    "route-unavailable",
    "route-closed",
    "insufficient-resource",
    "draw-limit-exceeded",
    "over-capacity",
    "participant-unavailable",
    "team-not-at-origin",
    "task-not-cancellable",
    "not-invited",
    "invitation-closed",
  ],
  policyAndScenario: [
    "no-change",
    "unknown-policy",
    "card-not-draft",
    "card-not-triggered",
    "card-not-found",
    "card-already-triggered",
    "invalid-effect",
    "campaign-exists",
    "unknown-faction",
  ],
  agentRefusal: [
    "danger",
    "duty",
    "past-breach",
    "low-trust",
    "lack-resources",
    "policy",
    "need-guarantee",
    "injured",
    "busy",
    "none",
  ],
} as const;

export type ReasonCodeGroup = keyof typeof reasonCodeGroups;

export type ReasonCode = (typeof reasonCodeGroups)[ReasonCodeGroup][number];

/** 按分组顺序展开的全部原因码，供目录完整性与逐项测试使用。 */
export const reasonCodes = [
  ...reasonCodeGroups.common,
  ...reasonCodeGroups.communication,
  ...reasonCodeGroups.agreement,
  ...reasonCodeGroups.task,
  ...reasonCodeGroups.policyAndScenario,
  ...reasonCodeGroups.agentRefusal,
] as const satisfies readonly ReasonCode[];

export const reasonCodeSchema = z.enum(reasonCodes);

/** 判断任意字符串是否为已登记原因码。 */
export function isReasonCode(value: string): value is ReasonCode {
  return reasonCodeSchema.safeParse(value).success;
}
