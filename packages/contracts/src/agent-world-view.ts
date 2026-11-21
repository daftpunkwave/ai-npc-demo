/**
 * 定义 Agent 世界视图：自身状态、静态地图、最后已知局势、本派系与持有的证据秘密。
 * 依赖玩家投影中的公共视图结构、领域值 schema 与 ID 校验。
 * 禁止在此读取实时世界状态；视图只能由该 Agent 的观察与自身状态推导。
 */
import { z } from "zod";
import { resourceAmountsSchema, roadStatusSchema, watergateAllocationSchema } from "./command-values";
import { contentIdSchemas, idSchemas, principalIdSchema } from "./ids";
import {
  agreementViewSchema,
  invitationViewSchema,
  mapNodeViewSchema,
  resourceLevelSchema,
  teamStatusSchema,
} from "./projection";
/** 带观察水位的已知数值。 */
export const knownNumberSchema = z
  .object({
    value: z.number(),
    asOfTick: z.number().int().nonnegative(),
  })
  .strict();

export type KnownNumber = z.infer<typeof knownNumberSchema>;

/** 带观察水位的已知枚举值。 */
export const knownAllocationSchema = z
  .object({
    value: watergateAllocationSchema,
    asOfTick: z.number().int().nonnegative(),
  })
  .strict();

export type KnownAllocation = z.infer<typeof knownAllocationSchema>;

/** Agent 自身状态：位置、伤情、当前任务、委托、邀请与协议。 */
export const agentSelfViewSchema = z
  .object({
    agentId: principalIdSchema,
    kind: z.enum(["character", "strategic"]),
    nodeId: contentIdSchemas.node.nullable(),
    injured: z.boolean(),
    injuredUntilTick: z.number().int().nonnegative().nullable(),
    currentTaskId: idSchemas.task.nullable(),
    delegations: z.array(
      z
        .object({
          delegationId: idSchemas.del,
          grantorFactionId: z.string().min(1),
          teamIds: z.array(contentIdSchemas.team),
          stockpileId: contentIdSchemas.sp.nullable(),
          maxDraw: resourceAmountsSchema,
          remaining: resourceAmountsSchema,
          untilTick: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    invitations: z.array(invitationViewSchema),
    agreements: z.array(agreementViewSchema),
    recentAgreements: z.array(agreementViewSchema),
  })
  .strict();

export type AgentSelfView = z.infer<typeof agentSelfViewSchema>;

/** 静态地理：人人都知道的地图属性，不含当前道路状态。 */
export const staticRoadViewSchema = z
  .object({
    roadId: contentIdSchemas.r,
    fromNodeId: contentIdSchemas.node,
    toNodeId: contentIdSchemas.node,
    travelTicks: z.number().int().positive(),
    risk: z.number().int().min(0).max(2),
  })
  .strict();

export const agentStaticMapViewSchema = z
  .object({
    nodes: z.array(mapNodeViewSchema),
    roads: z.array(staticRoadViewSchema),
  })
  .strict();

export type AgentStaticMapView = z.infer<typeof agentStaticMapViewSchema>;

/** 最后已知状态：每项都带该 Agent 观察到它时的 tick。 */
export const agentKnownRoadStatusSchema = z
  .object({
    roadId: contentIdSchemas.r,
    status: roadStatusSchema,
    asOfTick: z.number().int().nonnegative(),
  })
  .strict();

export const agentKnownStockpileSchema = z
  .object({
    stockpileId: contentIdSchemas.sp,
    supplyLevel: resourceLevelSchema,
    energyLevel: resourceLevelSchema,
    medicalLevel: resourceLevelSchema,
    asOfTick: z.number().int().nonnegative(),
  })
  .strict();

export const agentLastKnownViewSchema = z
  .object({
    relayStability: knownNumberSchema.nullable(),
    orchardWater: knownNumberSchema.nullable(),
    migrationSafety: knownNumberSchema.nullable(),
    watergateAllocation: knownAllocationSchema.nullable(),
    roads: z.array(agentKnownRoadStatusSchema),
    stockpiles: z.array(agentKnownStockpileSchema),
  })
  .strict();

export type AgentLastKnownView = z.infer<typeof agentLastKnownViewSchema>;

/** 本派系已知状态：战略 Agent、角色、库存精确数量与队伍状态。 */
export const agentFactionViewSchema = z
  .object({
    factionId: z.string().min(1),
    strategicAgentId: principalIdSchema,
    characterIds: z.array(principalIdSchema),
    stockpiles: z.array(
      z
        .object({
          stockpileId: contentIdSchemas.sp,
          amounts: resourceAmountsSchema,
          asOfTick: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    teams: z.array(
      z
        .object({
          teamId: contentIdSchemas.team,
          status: teamStatusSchema,
          asOfTick: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type AgentFactionView = z.infer<typeof agentFactionViewSchema>;

/** 持有的证据与秘密：秘密正文标注不可外传。 */
export const agentEvidenceViewSchema = z
  .object({
    evidenceId: contentIdSchemas.ev,
    title: z.string().min(1),
    body: z.string(),
  })
  .strict();

export const agentSecretViewSchema = z
  .object({
    secretId: contentIdSchemas.sec,
    body: z.string(),
    shareable: z.boolean(),
  })
  .strict();

/** Agent 世界视图：只能由该 Agent 的观察与自身状态推导，不是实时全量世界。 */
export const agentWorldViewSchema = z
  .object({
    self: agentSelfViewSchema,
    staticMap: agentStaticMapViewSchema,
    lastKnown: agentLastKnownViewSchema,
    faction: agentFactionViewSchema,
    evidence: z.array(agentEvidenceViewSchema),
    secrets: z.array(agentSecretViewSchema),
  })
  .strict();

export type AgentWorldView = z.infer<typeof agentWorldViewSchema>;
