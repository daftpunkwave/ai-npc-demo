/**
 * 核心职责：定义分层混合记忆每日整理模型请求、响应 schema 与提示词。
 * 交互契约：只处理已成型的身份、记忆与关系材料，不读取 revision 或存储。
 * 约束与禁忌：禁止提交模型输出为世界事实，也禁止在提示中注入未授权记录。
 */

import { z } from "zod";
import type { MemoryRecordView } from "@ai-npc/module-sdk";
import type { MemoryAgentIdentity } from "@ai-npc/module-sdk";
import { jsonValueSchema } from "@ai-npc/contracts";
import { dataOf, numberValue } from "./ledger-model";

export const dailyReviewOutputSchema = z
  .object({
    beliefOps: z
      .array(
        z
          .object({
            op: z.enum(["add", "update", "supersede", "keep"]),
            beliefId: z.string().min(1).nullable(),
            statement: z.string().min(1).max(60),
            evidenceIds: z.array(z.string().min(1)).min(1).max(6),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(5),
    currentConcerns: z.string().min(1).max(80).nullable(),
    intents: z
      .array(
        z
          .object({
            kind: z.enum(["seek-conversation", "remind", "avoid", "propose"]),
            targetId: z.string().min(1),
            reasonIds: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();

export type DailyReviewOutput = z.infer<typeof dailyReviewOutputSchema>;

export const dailyReviewOutputContract = {
  kind: "json" as const,
  schemaName: "daily-review",
  schema: jsonValueSchema.parse(z.toJSONSchema(dailyReviewOutputSchema)),
};

export function dailyReviewPrompt(input: {
  readonly identity: MemoryAgentIdentity;
  readonly today: readonly MemoryRecordView[];
  readonly beliefs: readonly MemoryRecordView[];
  readonly relations: readonly { targetId: string; trust: number; affinity: number; wariness: number }[];
}): { readonly system: string; readonly user: string } {
  const system = [
    `你在帮“${input.identity.name ?? input.identity.factionId}”在一天结束时整理认知。`,
    "依据【今天的重要经历】【已有看法】【关系摘要】输出 JSON：",
    '{"beliefOps":[{"op":"add|update|supersede|keep","beliefId":null,"statement":"不超过 60 字","evidenceIds":["mem-..."],"confidence":0.0}],',
    ' "currentConcerns":"不超过 80 字，你此刻最挂心的事；没有变化时填 null",',
    ' "intents":[{"kind":"seek-conversation|remind|avoid|propose","targetId":"...","reasonIds":["mem-..."]}]}',
    "规则：每条看法必须引用已存在的记忆 ID；update 与 supersede 必须填写已有看法的 beliefId；intents 最多 2 条，kind 只能从给定选项中选；不要编造。",
  ].join("\n");
  const today = input.today.length === 0
    ? "- 无"
    : input.today.map((record) => `- [${record.memoryId}] ${record.content.summaryZh}（${record.tier}·${record.epistemic}）`).join("\n");
  const beliefs = input.beliefs.length === 0
    ? "- 无"
    : input.beliefs.map((record) =>
      `- [${record.memoryId}] ${record.content.summaryZh}（置信度 ${numberValue(dataOf(record)["confidence"]) ?? record.salience}）`,
    ).join("\n");
  const relations = input.relations.length === 0
    ? "- 无"
    : input.relations.map((relation) =>
      `- ${relation.targetId}: trust=${relation.trust}, affinity=${relation.affinity}, wariness=${relation.wariness}`,
    ).join("\n");
  return {
    system,
    user: [
      `【你是谁】${input.identity.name ?? input.identity.factionId}，${input.identity.role ?? "未知职责"}；价值取向：${input.identity.values.join("、")}`,
      "【今天的重要经历】",
      today,
      "【已有看法】",
      beliefs,
      "【关系摘要】",
      relations,
    ].join("\n"),
  };
}