/**
 * 加载名册身份引用的工具授权清单。
 * 使用既有配置引用解析器及严格的工具绑定字段校验。
 * 工具实现与权限组合由已绑定的工具目录验证。
 */
import { z } from "zod";
import { configRefSchema } from "./schema";
import { loadConfigDocument, type ConfigLoadContext } from "./load-config";

const toolsetSchema = z.object({
  schemaVersion: z.literal(1),
  toolsetId: configRefSchema,
  tools: z.array(z.object({
    toolId: z.string().min(1),
    version: z.string().min(1),
    permissionProfile: z.string().min(1),
    budgetProfile: z.enum(["query", "command"]),
    viewConstraints: z.object({
      maxListItems: z.number().int().positive(),
      maxTokens: z.number().int().positive(),
    }).strict(),
  }).strict()),
}).strict();

export type AgentToolset = z.infer<typeof toolsetSchema>;

export function loadAgentToolset(ref: string, context: ConfigLoadContext): AgentToolset {
  const loaded = loadConfigDocument(ref, toolsetSchema, context, "toolset");
  if (loaded.value.toolsetId !== ref) throw new Error(`Toolset "${ref}" has a mismatched ID`);
  return loaded.value;
}
