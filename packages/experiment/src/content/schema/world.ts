/**
 * 定义 pack、lore、map、factions 与 characters 内容文件的严格 schema。
 * 依赖公共契约的领域值与 schema 共用辅助；只描述字段形状，不做跨文件引用检查。
 * 禁止在此读取文件或放宽未知键。
 */
import { principalIdSchema, roadStatusSchema, taskTypeSchema } from "@world-prism/contracts";
import { z } from "zod";
import {
  contentIdSchema,
  factionIdSchema,
  nodeIdSchema,
  personaFieldsSchema,
  roadIdSchema,
  schemaVersion,
  textSchema,
} from "./common";

/** pack.yaml：包标识、版本与文件清单。 */
export const contentPackSchema = z
  .object({
    schemaVersion,
    packId: contentIdSchema,
    contentVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "内容版本必须为 major.minor.patch 格式"),
    defaultScenario: textSchema,
    files: z.array(textSchema).min(1),
    scenarios: z.array(textSchema).min(1),
    scripts: z.array(textSchema),
  })
  .strict();

/** lore.yaml：所有主体共享的公开世界观。 */
export const contentLoreSchema = z
  .object({
    schemaVersion,
    summary: textSchema,
    chapter: z
      .object({
        id: textSchema,
        title: textSchema,
        motionTick: z.number().int().positive(),
        publicPressure: textSchema,
      })
      .strict(),
    timeUnit: textSchema,
  })
  .strict();

/** map.yaml：等距网格坐标与道路。 */
export const contentMapSchema = z
  .object({
    schemaVersion,
    nodes: z
      .array(
        z
          .object({
            nodeId: nodeIdSchema,
            name: textSchema,
            x: z.number().int().min(0).max(23),
            y: z.number().int().min(0).max(23),
            facilities: z.array(textSchema),
          })
          .strict(),
      )
      .min(1),
    roads: z
      .array(
        z
          .object({
            roadId: roadIdSchema,
            a: nodeIdSchema,
            b: nodeIdSchema,
            travelTicks: z.number().int().positive(),
            risk: z.number().int().min(0).max(2),
            controlledBy: factionIdSchema.optional(),
            initialStatus: roadStatusSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    migrationRoads: z.array(roadIdSchema),
    medicalFacilities: z.array(textSchema),
  })
  .strict();

/** factions.yaml：八个派系与战略 Agent 人格；人类派系有党部与前哨，外域只有领地。 */
export const contentFactionsSchema = z
  .object({
    schemaVersion,
    factions: z
      .array(
        z
          .object({
            factionId: factionIdSchema,
            name: textSchema,
            kind: z.enum(["human", "species"]),
            leaderCharacterId: contentIdSchema.optional(),
            leaderName: textSchema.optional(),
            factionHomeNodeId: nodeIdSchema.optional(),
            outpostNodeId: nodeIdSchema.optional(),
            territoryNodeId: nodeIdSchema.optional(),
            playerSeat: textSchema.optional(),
            persona: z
              .object({
                role: textSchema,
                focus: textSchema,
                skills: z.array(taskTypeSchema).optional(),
                secret: textSchema.optional(),
                ...personaFieldsSchema,
              })
              .strict(),
            relations: z
              .array(
                z
                  .object({
                    targetId: principalIdSchema,
                    trust: z.number().int().min(-2).max(2),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** characters.yaml：十一个角色的人格与初始背景关系。 */
export const contentCharactersSchema = z
  .object({
    schemaVersion,
    characters: z
      .array(
        z
          .object({
            agentId: contentIdSchema,
            characterId: contentIdSchema.optional(),
            name: textSchema,
            factionId: factionIdSchema,
            role: textSchema,
            spawnNodeId: nodeIdSchema,
            skills: z.array(textSchema),
            secret: textSchema.optional(),
            ...personaFieldsSchema,
            permissions: z.array(z.enum(["broadcast"])).optional(),
            initialRelations: z.array(
              z
                .object({
                  targetId: principalIdSchema,
                  label: textSchema,
                  trust: z.number().int().min(-2).max(2),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ContentPackFile = z.infer<typeof contentPackSchema>;
export type ContentLore = z.infer<typeof contentLoreSchema>;
export type ContentMap = z.infer<typeof contentMapSchema>;
export type ContentFactions = z.infer<typeof contentFactionsSchema>;
export type ContentCharacters = z.infer<typeof contentCharactersSchema>;

export type ContentNode = ContentMap["nodes"][number];
export type ContentRoad = ContentMap["roads"][number];
export type ContentFaction = ContentFactions["factions"][number];
export type ContentCharacter = ContentCharacters["characters"][number];
