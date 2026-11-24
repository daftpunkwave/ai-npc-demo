/**
 * 定义世界、地图、实体状态、指标与章节结算事件的 payload schema。
 * 依赖领域值 schema、ID 与 JSON 校验；事件信封与受众由宿主另行补充。
 * 禁止在此计算事件结果或写入世界状态，payload 只描述已提交的事实。
 */
import { z } from "zod";
import { contentIdSchemas, idSchemas, principalIdSchema } from "./ids";
import {
  cityResourceAmountsSchema,
  meterChangeSchema,
  meterSnapshotSchema,
  numericMeterIdSchema,
  roadStatusSchema,
} from "./command-values";

export const campaignStartedPayloadSchema = z
  .object({
    campaignId: idSchemas.cmp,
    factionId: z.string().min(1),
    playerId: principalIdSchema,
  })
  .strict();

export const passageGrantedPayloadSchema = z
  .object({
    grantId: idSchemas.pg,
    roadId: contentIdSchemas.r,
    granteeFactionId: z.string().min(1),
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

export const policyChangedPayloadSchema = z
  .object({
    key: z.string().min(1),
    oldValue: z.string().min(1),
    newValue: z.string().min(1),
    byId: principalIdSchema,
  })
  .strict();

export const characterMovedPayloadSchema = z
  .object({
    id: principalIdSchema,
    fromNodeId: contentIdSchemas.node,
    toNodeId: contentIdSchemas.node,
  })
  .strict();

export const teamMovedPayloadSchema = z
  .object({
    id: contentIdSchemas.team,
    fromNodeId: contentIdSchemas.node,
    toNodeId: contentIdSchemas.node,
  })
  .strict();

/** 受伤与恢复共用同一组字段：恢复事件中的 untilTick 是恢复时刻。 */
export const characterInjuryPayloadSchema = z
  .object({
    agentId: principalIdSchema,
    untilTick: z.number().int().nonnegative(),
    cause: z.string().min(1),
  })
  .strict();

export const teamRecoveredPayloadSchema = z
  .object({
    teamId: contentIdSchemas.team,
  })
  .strict();

export const evidenceDiscoveredPayloadSchema = z
  .object({
    evidenceId: contentIdSchemas.ev,
    discoveredBy: principalIdSchema,
    taskId: idSchemas.task,
  })
  .strict();

/** 侦察报告的公开内容：相邻道路状态、在场角色与群体状态。 */
export const scoutReportSchema = z
  .object({
    roads: z.array(z.object({ roadId: contentIdSchemas.r, status: roadStatusSchema }).strict()),
    characterIds: z.array(principalIdSchema),
    groups: z.array(z.object({ groupId: contentIdSchemas.grp, status: z.string().min(1) }).strict()),
  })
  .strict();

export type ScoutReport = z.infer<typeof scoutReportSchema>;

export const scoutReportedPayloadSchema = z
  .object({
    taskId: idSchemas.task,
    nodeId: contentIdSchemas.node,
    report: scoutReportSchema,
  })
  .strict();

export const groupRescuedPayloadSchema = z
  .object({
    groupId: contentIdSchemas.grp,
    taskId: idSchemas.task,
    dispatcherId: principalIdSchema,
  })
  .strict();

export const groupWorsenedPayloadSchema = z
  .object({
    groupId: contentIdSchemas.grp,
  })
  .strict();

export const metersChangedPayloadSchema = z
  .object({
    changes: z.array(meterChangeSchema),
  })
  .strict();

/** 阈值危机事件只携带触发时的数值，供通知与观察摘要使用。 */
export const meterThresholdPayloadSchema = z
  .object({
    value: z.number(),
  })
  .strict();

export const dayPassedPayloadSchema = z
  .object({
    day: z.number().int().positive(),
    meters: meterSnapshotSchema,
    consumption: z
      .object({
        supply: z.number().int().nonnegative(),
        energy: z.number().int().nonnegative(),
        medical: z.number().int().nonnegative(),
      })
      .strict(),
    changes: z.array(meterChangeSchema),
  })
  .strict();

export const chapterStageOutcomeSchema = z.enum(["equilibrium", "strained"]);

export type ChapterStageOutcome = z.infer<typeof chapterStageOutcomeSchema>;

export const chapterStageEvaluatedPayloadSchema = z
  .object({
    outcome: chapterStageOutcomeSchema,
    meters: meterSnapshotSchema,
    unmet: z.array(numericMeterIdSchema),
    fulfilledCount: z.number().int().nonnegative(),
    breachedCount: z.number().int().nonnegative(),
    /** t168 交接数据：六种城市资源按设计初值起算；旧事件没有该字段时按 null 兼容读取。 */
    cityResources: cityResourceAmountsSchema.nullable().default(null),
  })
  .strict();
