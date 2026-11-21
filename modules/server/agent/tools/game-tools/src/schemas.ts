/**
 * 核心职责：定义模型可见工具的平铺参数 schema 与命令转换输入。
 * 交互契约：未使用字段以 null 表示，调用前由网关删除 null 并交给严格命令 schema。
 * 约束与禁忌：不得接受 agentId、世界 scope 或自由文本台词字段。
 */
import {
  contentIdSchemas,
  dialogueIntentKindSchema,
  resourceIdSchema,
  watergateAllocationSchema,
} from "@ai-npc/contracts";
import { z } from "zod";

const speechIntentKinds = dialogueIntentKindSchema.options.filter((kind) => kind !== "none");
const agentReasonCodes = z.enum([
  "none",
  "danger",
  "duty",
  "past-breach",
  "low-trust",
  "lack-resources",
  "policy",
  "need-guarantee",
  "injured",
  "busy",
]);
const cargoSchema = z
  .object({
    supply: z.number().int(),
    energy: z.number().int(),
    medical: z.number().int(),
  })
  .strict();
const flatTermSchema = z
  .object({
    kind: z.enum([
      "deliver",
      "escort",
      "rescue",
      "repair-relay",
      "share-evidence",
      "grant-passage",
      "water-allocation",
      "delegate",
    ]),
    obligorId: z.string().min(1),
    resource: resourceIdSchema.nullable(),
    amount: z.number().int().nullable(),
    fromStockpileId: contentIdSchemas.sp.nullable(),
    toStockpileId: contentIdSchemas.sp.nullable(),
    byTick: z.number().int().nullable(),
    untilTick: z.number().int().nullable(),
    roadId: contentIdSchemas.r.nullable(),
    groupId: contentIdSchemas.grp.nullable(),
    evidenceId: contentIdSchemas.ev.nullable(),
    toPrincipalId: z.string().min(1).nullable(),
    granteeFactionId: z.string().min(1).nullable(),
    policy: watergateAllocationSchema.nullable(),
    granteeId: z.string().min(1).nullable(),
    teamIds: z.array(contentIdSchemas.team).nullable(),
    stockpileId: contentIdSchemas.sp.nullable(),
    maxDraw: cargoSchema.nullable(),
  })
  .strict();

const dispatchSchema = z
  .object({
    taskType: z.enum(["transport", "escort", "rescue", "repair", "scout"]),
    teamId: contentIdSchemas.team,
    invitees: z.array(z.string().min(1)).max(4),
    fromStockpileId: contentIdSchemas.sp.nullable(),
    toStockpileId: contentIdSchemas.sp.nullable(),
    cargo: cargoSchema.nullable(),
    roadId: contentIdSchemas.r.nullable(),
    durationTicks: z.number().int().nullable(),
    groupId: contentIdSchemas.grp.nullable(),
    toNodeId: contentIdSchemas.node.nullable(),
    medicalStockpileId: contentIdSchemas.sp.nullable(),
    energyStockpileId: contentIdSchemas.sp.nullable(),
    supplyStockpileId: contentIdSchemas.sp.nullable(),
    nodeId: contentIdSchemas.node.nullable(),
    departAfterTicks: z.number().int().nullable(),
  })
  .strict();

export const gameToolInputSchemas = {
  "world.inspect": z.object({ nodeId: z.string().min(1).nullable() }).strict(),
  "route.inspect": z
    .object({ fromNodeId: z.string().min(1), toNodeId: z.string().min(1), teamId: contentIdSchemas.team.nullable() })
    .strict(),
  "task.inspect": z.object({ taskId: z.string().min(1).nullable() }).strict(),
  "conversation.inspect": z
    .object({ conversationId: z.string().min(1).nullable(), limit: z.number().int().nonnegative() })
    .strict(),
  "operation.inspect": z.object({ operationId: z.string().min(1) }).strict(),
  "message.send": z
    .object({
      to: z.array(z.string().min(1)).min(1).max(4),
      intent: z
        .object({
          kind: z.enum(speechIntentKinds as [string, ...string[]]),
          tone: z.enum(["warm", "neutral", "cold", "urgent"]),
          reasonCode: agentReasonCodes,
          subjectRef: z.string().min(1).nullable(),
          factRefs: z.array(z.string().min(1)).max(6),
        })
        .strict(),
    })
    .strict(),
  "information.share": z
    .object({ evidenceId: contentIdSchemas.ev, audience: z.array(z.string().min(1)).min(1).max(4) })
    .strict(),
  "agreement.propose": z
    .object({
      parties: z.array(z.string().min(1)).min(2).max(6),
      terms: z.array(flatTermSchema).min(1).max(8),
      expiresInTicks: z.number().int().positive().nullable(),
    })
    .strict(),
  "agreement.respond": z
    .object({
      agreementId: z.string().min(1),
      response: z.enum(["accept", "reject", "counter"]),
      counterTerms: z.array(flatTermSchema).min(1).max(8).nullable(),
    })
    .strict(),
  "asset.dispatch": dispatchSchema,
  "task.respond": z
    .object({
      taskId: z.string().min(1),
      response: z.enum(["accept", "decline"]),
      reasonCode: z.string().min(1),
    })
    .strict(),
  "task.cancel": z.object({ taskId: z.string().min(1) }).strict(),
  "policy.set": z.object({ key: z.string().min(1), value: z.string().min(1) }).strict(),
} as const;

export type GameToolId = keyof typeof gameToolInputSchemas;

export const commandToolIds: ReadonlySet<GameToolId> = new Set([
  "message.send",
  "information.share",
  "agreement.propose",
  "agreement.respond",
  "asset.dispatch",
  "task.respond",
  "task.cancel",
  "policy.set",
]);

export { flatTermSchema };