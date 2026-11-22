/**
 * 定义 world-init、evidence、starts、scenario 与脚本内容文件的严格 schema。
 * 依赖公共契约的命令与领域值 schema；只描述字段形状，不做跨文件引用检查。
 * 禁止在此读取文件或填充运行时生成的 ID。
 */
import {
  cardEffectSchema,
  commandRequestSchema,
  principalIdSchema,
  resourceAmountsSchema,
  taskTypeSchema,
} from "@ai-npc/contracts";
import { z } from "zod";
import {
  contentIdSchema,
  evidenceIdSchema,
  factionIdSchema,
  groupIdSchema,
  nodeIdSchema,
  nonNegativeIntSchema,
  roadIdSchema,
  schemaVersion,
  secretIdSchema,
  scenarioCardIdSchema,
  stockpileIdSchema,
  teamIdSchema,
  textSchema,
} from "./common";

/** world-init.yaml：指标、库存、队伍、群体、职责委托与玩家初态。 */
export const contentWorldInitSchema = z
  .object({
    schemaVersion,
    meters: z
      .object({
        "relay.stability": z.number().min(0).max(100),
        "orchard.water": z.number().min(0).max(100),
        "migration.safety": z.number().min(0).max(100),
        "watergate.allocation": z.enum(["harbor-first", "rotation", "orchard-first"]),
      })
      .strict(),
    stockpiles: z
      .array(
        z
          .object({
            stockpileId: stockpileIdSchema,
            nodeId: nodeIdSchema,
            ownerFactionId: factionIdSchema,
            supply: nonNegativeIntSchema,
            energy: nonNegativeIntSchema,
            medical: nonNegativeIntSchema,
          })
          .strict(),
      )
      .min(1),
    teams: z
      .array(
        z
          .object({
            teamId: teamIdSchema,
            ownerFactionId: factionIdSchema,
            nodeId: nodeIdSchema,
            capabilities: z.array(taskTypeSchema).min(1),
            capacity: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    groups: z.array(
      z
        .object({
          groupId: groupIdSchema,
          nodeId: nodeIdSchema,
          injured: nonNegativeIntSchema,
          deadlineTick: nonNegativeIntSchema,
        })
        .strict(),
    ),
    dutyDelegations: z.array(
      z
        .object({
          granteeId: principalIdSchema,
          grantorFactionId: factionIdSchema,
          teamIds: z.array(teamIdSchema).min(1),
          stockpileId: stockpileIdSchema,
          maxDraw: resourceAmountsSchema,
          untilTick: nonNegativeIntSchema,
        })
        .strict(),
    ),
    player: z
      .object({
        principalId: principalIdSchema,
        nodeId: nodeIdSchema,
      })
      .strict(),
  })
  .strict();

/** evidence.yaml：可分享证据与私有秘密。 */
export const contentEvidenceSchema = z
  .object({
    schemaVersion,
    evidence: z.array(
      z
        .object({
          evidenceId: evidenceIdSchema,
          title: textSchema,
          nodeId: nodeIdSchema.optional(),
          discoverable: z.boolean().optional(),
          heldBy: z.array(principalIdSchema).optional(),
          content: textSchema,
          tags: z.array(textSchema).min(1),
        })
        .strict(),
    ),
    secrets: z.array(
      z
        .object({
          secretId: secretIdSchema,
          heldBy: z.array(principalIdSchema).min(1),
          releasePolicy: z.literal("private"),
          content: textSchema,
          leakTerms: z.array(textSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();

/** starts.yaml：五个人类派系的开局委托、知识与消息；序章只启用公社席。 */
export const contentStartsSchema = z
  .object({
    schemaVersion,
    starts: z
      .array(
        z
          .object({
            factionId: factionIdSchema,
            enabled: z.boolean().default(true),
            contacts: z.array(principalIdSchema).min(1),
            commission: textSchema,
            playerDelegation: z
              .object({
                teamIds: z.array(teamIdSchema).min(1),
                stockpileId: stockpileIdSchema,
                maxDraw: resourceAmountsSchema,
                untilTick: nonNegativeIntSchema,
              })
              .strict(),
            knowledge: z.array(evidenceIdSchema),
            messages: z
              .array(
                z
                  .object({
                    from: principalIdSchema,
                    text: textSchema,
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** rules.yaml：章节规则的岗位、日结目标与公社席；规则层只消费描述符，不写具体内容 ID。 */
export const contentRulesSchema = z
  .object({
    schemaVersion,
    tasks: z
      .object({
        capacitySupporter: z
          .object({
            agentId: principalIdSchema,
            capacityBonus: z.number().int().positive(),
          })
          .strict(),
        repairSupporter: z
          .object({
            agentId: principalIdSchema,
            stabilityBonus: z.number().int().positive(),
          })
          .strict(),
        rescueSupporter: z
          .object({
            agentId: principalIdSchema,
            durationDiscountTicks: z.number().int().positive(),
          })
          .strict(),
        scoutSupporter: z
          .object({
            agentId: principalIdSchema,
            travelDiscountPerRoad: z.number().int().positive(),
          })
          .strict(),
        escortSupporter: z
          .object({
            agentId: principalIdSchema,
            safetyBonus: z.number().int().positive(),
          })
          .strict(),
        universalGuide: z
          .object({
            agentId: principalIdSchema,
            travelDiscountPerRoad: z.number().int().positive(),
          })
          .strict(),
        universalRepairer: z
          .object({
            agentId: principalIdSchema,
            stabilityBonus: z.number().int().positive(),
            excludedTeamIds: z.array(teamIdSchema),
          })
          .strict(),
        repairWorkNodeId: nodeIdSchema,
        energyOnlyRepairTeamIds: z.array(teamIdSchema),
        repairBaseStability: z
          .object({
            standard: z.number().int().positive(),
            energyOnly: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    settlement: z
      .object({
        dailySupplyStockpileId: stockpileIdSchema,
        dailySupplyAmount: z.number().int().positive(),
        orchardMedicalStockpileId: stockpileIdSchema,
        orchardMedicalAmount: z.number().int().positive(),
        migrationRoadId: roadIdSchema,
        migrationPassageFactionId: factionIdSchema,
      })
      .strict(),
    watergateSeatId: textSchema,
  })
  .strict();

/** scenarios/*.yaml：首章剧情卡；效果形状复用公共契约。 */
export const contentScenarioSchema = z
  .object({
    schemaVersion,
    scenarioId: contentIdSchema,
    /** 剧情卡广播的发布节点；与玩家当前位置无关。 */
    broadcastOriginNodeId: nodeIdSchema,
    /** 触发后启用每日剧情压力的卡片；缺省表示本章没有压力卡。 */
    pressureCardId: scenarioCardIdSchema.optional(),
    /** 只作事件署名、不实例化角色的具名人物名单。 */
    signatureOnlyPrincipalIds: z.array(principalIdSchema),
    cards: z
      .array(
        z
          .object({
            cardId: scenarioCardIdSchema,
            version: z.number().int().positive(),
            trigger: z.object({ atTick: nonNegativeIntSchema }).strict(),
            effects: z.array(cardEffectSchema).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** 脚本中的外发命令；载荷复用命令契约的严格校验。 */
const scriptStepSchema = z
  .object({
    atTick: nonNegativeIntSchema,
    as: principalIdSchema,
    command: commandRequestSchema,
  })
  .strict();

/** 实验脚本：外部输入、检查点探针与命名分支。 */
export const contentScriptSchema = z
  .object({
    schemaVersion,
    scriptId: contentIdSchema,
    rosterRef: textSchema,
    start: z.object({ factionId: factionIdSchema }).strict(),
    setup: z
      .array(z.object({ grantEvidence: evidenceIdSchema, to: principalIdSchema }).strict())
      .optional(),
    steps: z.array(scriptStepSchema),
    checkpoints: z.array(
      z
        .object({
          atTick: nonNegativeIntSchema,
          probes: z
            .array(
              z
                .object({
                  probeId: textSchema,
                  agentId: principalIdSchema,
                  askedBy: principalIdSchema,
                  question: textSchema,
                  kind: z.enum(["recall", "unknown", "secret", "belief"]),
                  answerKey: z
                    .object({
                      mustMention: z.array(z.string()),
                      mustNotMention: z.array(z.string()),
                    })
                    .strict(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
    branches: z
      .array(
        z
          .object({
            name: contentIdSchema,
            addSteps: z.array(scriptStepSchema),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type ContentWorldInit = z.infer<typeof contentWorldInitSchema>;
export type ContentRules = z.infer<typeof contentRulesSchema>;
export type ContentEvidence = z.infer<typeof contentEvidenceSchema>;
export type ContentStarts = z.infer<typeof contentStartsSchema>;
export type ContentScenario = z.infer<typeof contentScenarioSchema>;
export type ContentScript = z.infer<typeof contentScriptSchema>;
export type ContentScriptStep = z.infer<typeof scriptStepSchema>;

export type ContentStockpile = ContentWorldInit["stockpiles"][number];
export type ContentTeam = ContentWorldInit["teams"][number];
export type ContentGroup = ContentWorldInit["groups"][number];
export type ContentDutyDelegation = ContentWorldInit["dutyDelegations"][number];
export type ContentEvidenceEntry = ContentEvidence["evidence"][number];
export type ContentSecret = ContentEvidence["secrets"][number];
export type ContentStart = ContentStarts["starts"][number];
export type ContentCard = ContentScenario["cards"][number];
