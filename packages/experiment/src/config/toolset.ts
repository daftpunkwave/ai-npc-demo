/**
 * 加载单份 ToolBinding 工具集，校验定义引用形态与调用限额。
 * 依赖配置引用、Zod 与公共 JSON 契约。
 * 禁止在工具集中复制 executor、模型配置或身份能力。
 */
import { z } from "zod";
import { loadConfigDocument, type ConfigLoadContext, type LoadedConfig } from "./load-config";

export const toolsetSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolsetId: z.string().min(1),
    tools: z
      .array(
        z
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
          .strict(),
      )
      .min(1),
  })
  .strict();

export type Toolset = z.infer<typeof toolsetSchema>;

export function loadToolset(
  configRef: string,
  context: ConfigLoadContext,
): LoadedConfig<Toolset> {
  const loaded = loadConfigDocument(configRef, toolsetSchema, context, "toolset");
  if (loaded.value.toolsetId !== configRef) {
    throw new Error(`toolsetId「${loaded.value.toolsetId}」与引用「${configRef}」不一致`);
  }
  return loaded;
}
