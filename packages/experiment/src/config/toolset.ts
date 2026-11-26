/**
 * 加载名册身份引用的工具授权清单。
 * 使用既有配置引用解析器及严格的工具绑定字段校验。
 * 工具实现与权限组合由已绑定的工具目录验证。
 */
import { toolsetDocumentSchema, type ToolsetDocument } from "@ai-npc/contracts";
import { referenceLoadingError } from "../loading/errors";
import { loadConfigDocument, type ConfigLoadContext } from "./load-config";

export type { ToolsetDocument as AgentToolset } from "@ai-npc/contracts";

export function loadAgentToolset(ref: string, context: ConfigLoadContext): ToolsetDocument {
  const loaded = loadConfigDocument(ref, toolsetDocumentSchema, context, "toolset");
  if (loaded.value.toolsetId !== ref) {
    throw referenceLoadingError(
      loaded.source,
      "toolsetId",
      `Toolset「${loaded.value.toolsetId}」与引用「${ref}」不一致`,
    );
  }
  return loaded.value;
}
