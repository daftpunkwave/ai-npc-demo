/**
 * 核心职责：按当前 Agent 的动态权限收窄模型工具 schema，并省略空枚举工具。
 * 交互契约：输入已冻结 ToolBinding 与授权值集合，输出稳定排序的 NormalizedTool。
 * 约束与禁忌：不得执行工具、读取世界或把一次收窄结果复用到后续 turn。
 */
import {
  toModelToolName,
  type Json,
  type NormalizedTool,
  type ToolBinding,
  type ToolDefinition,
} from "@ai-npc/contracts";
import type { AgentToolsPort } from "@ai-npc/module-sdk";

export interface ToolNarrowingValues {
  readonly messagePrincipalIds?: ReadonlySet<string>;
  readonly teamIds?: readonly string[];
  readonly policyKeys?: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly invitedTaskIds?: readonly string[];
}

export interface NarrowedToolOmission {
  readonly toolId: string;
  readonly reason: "empty-enum" | "missing-authorization";
  readonly field: string;
}

export interface ToolRequestProjection {
  readonly tools: readonly NormalizedTool[];
  readonly bindings: readonly ToolBinding[];
  readonly omissions: readonly NarrowedToolOmission[];
}

interface DynamicField {
  readonly field: string;
  readonly values: readonly string[] | undefined;
}

function dynamicFieldFor(toolId: string, values: ToolNarrowingValues): DynamicField | null {
  switch (toolId) {
    case "asset.dispatch":
      return { field: "teamId", values: values.teamIds };
    case "policy.set":
      return { field: "key", values: values.policyKeys };
    case "information.share":
      return { field: "evidenceId", values: values.evidenceIds };
    case "task.respond":
      return { field: "taskId", values: values.invitedTaskIds };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function narrowSchema(schema: Json, field: string, values: readonly string[]): Json {
  if (!isRecord(schema)) return schema;
  const maybeProperties = schema["properties"];
  if (!isRecord(maybeProperties)) return schema;
  const properties = maybeProperties;
  const target = properties[field];
  if (!isRecord(target)) throw new Error(`tool schema field ${field} is not an object`);
  return {
    ...schema,
    properties: {
      ...properties,
      [field]: {
        ...target,
        enum: [...new Set(values)].sort((left, right) => left.localeCompare(right)),
      },
    },
  };
}

/** 为当前 turn 投影工具，不修改已注册的工具定义。 */
export function narrowToolsForTurn(
  tools: AgentToolsPort,
  agentId: string,
  values: ToolNarrowingValues,
): ToolRequestProjection {
  const bindings = [...tools.bindingsFor(agentId)];
  const projected: NormalizedTool[] = [];
  const visibleBindings: ToolBinding[] = [];
  const omissions: NarrowedToolOmission[] = [];
  for (const binding of bindings) {
    const definition: ToolDefinition | null = tools.definition(binding.toolId, binding.version);
    if (definition === null) throw new Error(`tool definition missing for ${binding.toolId}@${binding.version}`);
    const dynamic = dynamicFieldFor(binding.toolId, values);
    let inputSchema = definition.inputSchema;
    if (dynamic !== null) {
      if (dynamic.values === undefined) {
        omissions.push({ toolId: binding.toolId, reason: "missing-authorization", field: dynamic.field });
        continue;
      }
      if (dynamic.values.length === 0) {
        omissions.push({ toolId: binding.toolId, reason: "empty-enum", field: dynamic.field });
        continue;
      }
      inputSchema = narrowSchema(definition.inputSchema, dynamic.field, dynamic.values);
    }
    projected.push({
      name: toModelToolName(definition.toolId),
      description: definition.description,
      inputSchema,
    });
    visibleBindings.push(binding);
  }
  return { tools: projected, bindings: visibleBindings, omissions };
}

export function allowedDynamicValues(
  toolId: string,
  values: ToolNarrowingValues,
): readonly string[] | undefined {
  return dynamicFieldFor(toolId, values)?.values;
}

export function dynamicFieldName(toolId: string): string | null {
  return dynamicFieldFor(toolId, {})?.field ?? null;
}
