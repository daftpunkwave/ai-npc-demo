/**
 * 核心职责：校验工具集文件的完整 binding 模板形状。
 * 交互契约：每份文件独立列出全部工具，不支持继承或隐式默认项。
 * 约束与禁忌：不得在解析阶段解析动态权限或调用 executor。
 */
import { z } from "zod";

export const toolsetEntrySchema = z
  .object({
    toolId: z.string().min(1),
    version: z.string().min(1),
    permissionProfile: z.string().min(1),
    budgetProfile: z.enum(["query", "command"]),
    viewConstraints: z
      .object({
        maxListItems: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const toolsetDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolsetId: z.string().min(1),
    tools: z.array(toolsetEntrySchema).min(1),
  })
  .strict();

export type ToolsetDocument = z.infer<typeof toolsetDocumentSchema>;