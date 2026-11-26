/**
 * 定义 Agent 工具与决策的公共结构：工具定义、工具绑定与工具集、工具执行结果、对白意图、
 * 值得记录的事件、决策提交与言语输出。
 * 依赖工具结果原因码、ID、JSON 与决策值契约；只声明结构，不含工具实现或模型调用。
 * 禁止在此执行工具、裁决权限或持久化决策。
 */
import { z } from "zod";
import { commandStatusSchema, executionStatusSchema, taskStatusSchema } from "./envelopes";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";
import { toolResultReasonCodeSchema } from "./reason-codes";


export const toolDefinitionSchema = z
  .object({
    toolId: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    effect: z.enum(["query", "command"]),
    commandType: z.string().min(1).nullable(),
    inputSchema: jsonValueSchema,
    outputSchema: jsonValueSchema,
    viewFields: z.array(z.string().min(1)),
    permissionProfile: z.string().min(1),
  })
  .strict();

export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const toolBindingSchema = z
  .object({
    bindingId: z.string().min(1),
    agentId: principalIdSchema,
    toolId: z.string().min(1),
    version: z.string().min(1),
    permissionProfile: z.string().min(1),
    maxCallsPerTurn: z.number().int().nonnegative(),
    viewConstraints: z
      .object({
        maxListItems: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type ToolBinding = z.infer<typeof toolBindingSchema>;

export const toolsetEntrySchema = toolBindingSchema.pick({
  toolId: true,
  version: true,
  permissionProfile: true,
  viewConstraints: true,
}).extend({ budgetProfile: z.enum(["query", "command"]) });

export const toolsetDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  toolsetId: z.string().min(1),
  tools: z.array(toolsetEntrySchema).min(1),
}).strict();

export type ToolsetDocument = z.infer<typeof toolsetDocumentSchema>;

export const toolExecutionResultSchema = z
  .object({
    executionStatus: executionStatusSchema,
    commandStatus: commandStatusSchema.nullable(),
    taskStatus: taskStatusSchema.nullable(),
    reasonCode: toolResultReasonCodeSchema.nullable(),
    receiptId: z.string().min(1).nullable(),
    operationId: z.string().min(1).nullable(),
    resultRef: z.string().min(1),
    detail: z.string(),
    data: jsonValueSchema,
  })
  .strict();

export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>;

export const dialogueIntentSchema = z
  .object({
    kind: z.enum([
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
    ]),
    audience: z.array(principalIdSchema).max(4),
    tone: z.enum(["warm", "neutral", "cold", "urgent"]),
    reasonCode: z.enum([
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
    ]),
    subjectRef: z.string().min(1).nullable(),
    factRefs: z.array(z.string().min(1)).max(6),
  })
  .strict();

export type DialogueIntent = z.infer<typeof dialogueIntentSchema>;

export const noteworthySchema = z
  .object({
    kind: z.enum(["promise-by-other", "promise-by-me", "claim", "request"]),
    aboutId: principalIdSchema,
    summary: z.string().min(1).max(60),
    dueTick: z.number().int().nonnegative().nullable(),
    sourceRefs: z.array(z.string().min(1)).min(1).max(3),
  })
  .strict();

export const decisionSubmissionSchema = z
  .object({
    stance: z.enum(["accept", "decline", "negotiate", "defer", "inform", "none"]),
    dialogueIntent: dialogueIntentSchema,
    noteworthy: z.array(noteworthySchema).max(3),
    citedMemoryIds: z.array(idSchemas.mem).max(8),
    decisionNote: z.string().max(120),
  })
  .strict();

export type DecisionSubmission = z.infer<typeof decisionSubmissionSchema>;
export const decisionSubmitWireSchema = jsonValueSchema.parse(z.toJSONSchema(decisionSubmissionSchema));

export const speechOutputSchema = z.object({
  utterance: z.string().min(1).max(160),
  citedRefs: z.array(z.string()).max(6),
}).strict();

export const speechOutputWireSchema = jsonValueSchema.parse(z.toJSONSchema(speechOutputSchema));
