/**
 * 定义 prompts 与 locale 内容文件的严格 schema，以及模板覆盖所需的键目录。
 * 依赖公共契约的事件、原因码、任务类型与领域值；只描述字段形状与完整键集合。
 * 禁止在此渲染模板、判定关键词或改写中文文本。
 */
import {
  domainEventTypes,
  reasonCodeGroups,
  reasonCodes,
  roadStatusSchema,
  taskTypeSchema,
  watergateAllocationSchema,
  type DialogueIntentKind,
  type MeterChangeCause,
  type TermKind,
} from "@ai-npc/contracts";
import { z } from "zod";
import { exactRecord, textSchema } from "./common";

/** 对白意图全集；speechTemplates 只需覆盖会生成对白的 13 种。 */
const dialogueIntentKinds = [
  "none",
  "acknowledge",
  "answer",
  "agree",
  "refuse",
  "counter-offer",
  "request",
  "inform",
  "warn",
  "thank",
  "apologize",
  "decline-to-disclose",
  "report-result",
  "remind",
] as const satisfies readonly DialogueIntentKind[];

/** 生成对白的意图；none 表示不说话。 */
const speechIntentKinds = dialogueIntentKinds.filter(
  (kind): kind is Exclude<DialogueIntentKind, "none"> => kind !== "none",
);

/** 协议条款种类。 */
const termKinds = [
  "deliver",
  "escort",
  "rescue",
  "repair-relay",
  "share-evidence",
  "grant-passage",
  "water-allocation",
  "delegate",
] as const satisfies readonly TermKind[];

/** 指标变化的公开原因分类。 */
const causeKinds = [
  "daily",
  "task",
  "road-risk",
  "group-deadline",
  "scenario-pressure",
] as const satisfies readonly MeterChangeCause[];

/** 工具定义全集；toolDescriptions 必须逐项覆盖。 */
export const contentToolIds = [
  "world.inspect",
  "route.inspect",
  "task.inspect",
  "conversation.inspect",
  "operation.inspect",
  "message.send",
  "information.share",
  "agreement.propose",
  "agreement.respond",
  "asset.dispatch",
  "task.respond",
  "task.cancel",
  "policy.set",
  "decision.submit",
] as const;

/** prompts/zh-CN.yaml：模型模板、标签、观察模板与渲染词典。 */
export const contentPromptsSchema = z
  .object({
    templateVersion: textSchema,
    decision: z
      .object({
        system: textSchema,
        user: textSchema,
        nudgeSubmit: textSchema,
        budgetStop: textSchema,
        invalidReasons: exactRecord(["schema", "audience", "subject", "unknown-ref"], textSchema),
      })
      .strict(),
    toolDescriptions: exactRecord(contentToolIds, textSchema),
    jsonOutputSuffix: textSchema,
    speech: z.object({ system: textSchema, user: textSchema }).strict(),
    speechTemplates: exactRecord(speechIntentKinds, textSchema),
    speechReasons: exactRecord(reasonCodeGroups.agentRefusal, z.string()),
    speechNoFacts: textSchema,
    labels: z
      .object({
        kinds: exactRecord(["character", "strategic"], textSchema),
        intents: exactRecord(dialogueIntentKinds, textSchema),
        tones: exactRecord(["warm", "neutral", "cold", "urgent"], textSchema),
        reasons: exactRecord(reasonCodeGroups.agentRefusal, textSchema),
        trust: exactRecord(["devoted", "trusting", "neutral", "wary", "hostile"], textSchema),
        epistemic: exactRecord(["verified-event", "reported-claim", "inference"], textSchema),
        channels: exactRecord(
          [
            "face-to-face",
            "relay",
            "evidence",
            "probe",
            "broadcast",
            "rumor",
            "public-notice",
            "self",
            "party",
            "on-site",
            "briefing",
          ],
          textSchema,
        ),
      })
      .strict(),
    maintenance: z
      .object({
        reflection: z.object({ system: textSchema, user: textSchema }).strict(),
        dailyReview: z.object({ system: textSchema, user: textSchema }).strict(),
      })
      .strict(),
    probe: z.object({ question: textSchema }).strict(),
    observationTemplates: exactRecord(domainEventTypes, textSchema),
    observationChange: textSchema,
    causeNames: exactRecord(causeKinds, textSchema),
    effectTemplates: exactRecord(taskTypeSchema.options, textSchema),
    termTemplates: exactRecord(termKinds, textSchema),
  })
  .strict();

/** locale/zh-CN.yaml：原因码提示、名称、界面文字与规则词表。 */
export const contentLocaleSchema = z
  .object({
    reasonCodes: exactRecord(reasonCodes, textSchema),
    taskTypes: exactRecord(taskTypeSchema.options, textSchema),
    meters: exactRecord(
      ["relay.stability", "orchard.water", "migration.safety", "watergate.allocation"],
      textSchema,
    ),
    meterLevels: exactRecord(["critical", "strained", "stable"], textSchema),
    policyKeys: exactRecord(["watergate.allocation", "road.status"], textSchema),
    policyValues: exactRecord(
      [...watergateAllocationSchema.options, ...roadStatusSchema.options],
      textSchema,
    ),
    resources: exactRecord(["supply", "energy", "medical"], textSchema),
    resourceLevels: exactRecord(["scarce", "adequate", "surplus"], textSchema),
    nodes: z.record(z.string().min(1), textSchema),
    facilities: z.record(z.string().min(1), textSchema),
    playerName: textSchema,
    ui: z.record(z.string().min(1), textSchema),
    lexicons: z
      .object({
        taskKeywords: z
          .array(
            z
              .object({
                word: textSchema,
                taskType: z.enum(["transport", "escort", "rescue", "repair", "scout", "generic"]),
              })
              .strict(),
          )
          .min(1),
        questionMarkers: z.array(textSchema).min(1),
        unknownMarkers: z.array(textSchema).min(1),
        forgetMarkers: z.array(textSchema).min(1),
        completionClaims: z.array(textSchema).min(1),
        progressClaims: z.array(textSchema).min(1),
        memoryQueryTags: z
          .array(
            z
              .object({
                word: textSchema,
                tags: z.array(textSchema).min(1),
              })
              .strict(),
          )
          .min(1),
        personalityKeywords: exactRecord(
          ["agreement", "rescue", "resource", "road", "evidence"],
          z.array(textSchema).min(1),
        ),
      })
      .strict(),
  })
  .strict();

export type ContentPrompts = z.infer<typeof contentPromptsSchema>;
export type ContentLocale = z.infer<typeof contentLocaleSchema>;
