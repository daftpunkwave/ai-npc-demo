/**
 * 定义并加载 connections、models、mounts 与 evaluator 的集中模型布局。
 * 依赖配置引用、Zod、模型能力契约与名册身份。
 * 禁止在布局中保存密钥、自动补默认模型或接受重复挂载键。
 */
import { z } from "zod";
import {
  jsonValueSchema,
  modelCapabilitiesSchema,
  modelPurposeSchema,
  type Json,
  type ModelCapabilities,
  type Purpose,
} from "@ai-npc/contracts";
import { loadConfigDocument, type ConfigLoadContext, type LoadedConfig } from "./load-config";

const connectionSchema = z
  .object({
    adapterId: z.string().min(1),
    endpoint: z.string().min(1),
    credentialRef: z.string().min(1).nullable(),
    rateLimitKey: z.string().min(1),
    config: jsonValueSchema,
  })
  .strict();

const modelSchema = z
  .object({
    connectionId: z.string().min(1),
    externalModel: z.string().min(1),
    parameters: jsonValueSchema,
    capabilities: modelCapabilitiesSchema,
    maxConcurrent: z.number().int().positive(),
    requestsPerMinute: z.number().int().positive().nullable(),
    tokensPerMinute: z.number().int().positive().nullable(),
    maxOutputTokensByPurpose: z.record(z.string().min(1), z.number().int().positive()).optional(),
  })
  .strict();

const mountSchema = z
  .object({
    modelId: z.string().min(1),
    agentIds: z.array(z.string().min(1)).min(1),
    purposes: z.array(modelPurposeSchema).min(1),
  })
  .strict();

export const modelLayoutSchema = z
  .object({
    schemaVersion: z.literal(1),
    layoutId: z.string().min(1),
    connections: z.record(z.string().min(1), connectionSchema),
    models: z.record(z.string().min(1), modelSchema),
    mounts: z.array(mountSchema),
    evaluator: z
      .object({
        enabled: z.boolean(),
        principalId: z.string().min(1),
        modelId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ModelLayout = z.infer<typeof modelLayoutSchema>;

export interface ResolvedModelMount {
  readonly agentId: string;
  readonly purpose: Purpose;
  readonly modelId: string;
  readonly connectionId: string;
  readonly adapterId: string;
  readonly endpoint: string;
  readonly credentialRef: string | null;
  readonly externalModel: string;
  readonly parameters: Json;
  readonly capabilities: ModelCapabilities;
  readonly maxConcurrent: number;
  readonly requestsPerMinute: number | null;
  readonly tokensPerMinute: number | null;
  readonly maxOutputTokens: number;
}

/** 读取布局并校验文档 ID 与引用一致。 */
export function loadModelLayout(
  configRef: string,
  context: ConfigLoadContext,
): LoadedConfig<ModelLayout> {
  const loaded = loadConfigDocument(configRef, modelLayoutSchema, context, "model-layout");
  if (loaded.value.layoutId !== configRef) {
    throw new Error(`layoutId「${loaded.value.layoutId}」与引用「${configRef}」不一致`);
  }
  return loaded;
}

/** 展开唯一挂载表；重复 `(agentId, purpose)` 立即失败。 */
export function resolveModelMounts(layout: ModelLayout): readonly ResolvedModelMount[] {
  const mounts: ResolvedModelMount[] = [];
  const seen = new Set<string>();
  for (const mount of layout.mounts) {
    const model = layout.models[mount.modelId];
    if (model === undefined) {
      throw new Error(`挂载引用了不存在的模型 ${mount.modelId}`);
    }
    const connection = layout.connections[model.connectionId];
    if (connection === undefined) {
      throw new Error(`模型 ${mount.modelId} 引用了不存在的连接 ${model.connectionId}`);
    }
    for (const agentId of mount.agentIds) {
      for (const purpose of mount.purposes) {
        const key = `${agentId}\u0000${purpose}`;
        if (seen.has(key)) {
          throw new Error(`重复挂载：${agentId} 的 ${purpose}`);
        }
        seen.add(key);
        mounts.push({
          agentId,
          purpose,
          modelId: mount.modelId,
          connectionId: model.connectionId,
          adapterId: connection.adapterId,
          endpoint: connection.endpoint,
          credentialRef: connection.credentialRef,
          externalModel: model.externalModel,
          parameters: model.parameters,
          capabilities: model.capabilities,
          maxConcurrent: model.maxConcurrent,
          requestsPerMinute: model.requestsPerMinute,
          tokensPerMinute: model.tokensPerMinute,
          maxOutputTokens: model.maxOutputTokensByPurpose?.[purpose] ?? Math.min(model.capabilities.maxOutputTokens, 4096),
        });
      }
    }
  }
  return mounts;
}

/** 检查名册与必需 purpose 都有唯一挂载。 */
export function validateModelLayout(
  layout: ModelLayout,
  rosterAgentIds: readonly string[],
  requiredPurposes: readonly Purpose[],
): readonly ResolvedModelMount[] {
  const mounts = resolveModelMounts(layout);
  const keys = new Set(mounts.map((mount) => `${mount.agentId}\u0000${mount.purpose}`));
  const roster = new Set(rosterAgentIds);
  for (const mount of mounts) {
    if (!roster.has(mount.agentId)) {
      throw new Error(`模型布局挂载了名册外身份 ${mount.agentId}`);
    }
  }
  for (const agentId of rosterAgentIds) {
    for (const purpose of requiredPurposes) {
      if (!keys.has(`${agentId}\u0000${purpose}`)) {
        throw new Error(`身份 ${agentId} 缺少 ${purpose} 模型挂载`);
      }
    }
  }
  if (layout.evaluator.enabled && layout.models[layout.evaluator.modelId] === undefined) {
    throw new Error(`evaluator 引用了不存在的模型 ${layout.evaluator.modelId}`);
  }
  return mounts;
}

/** 生成去密钥、键序稳定的路由视图。 */
export function modelMountsJson(mounts: readonly ResolvedModelMount[]): Json {
  return mounts
    .map((mount) => ({
      agentId: mount.agentId,
      purpose: mount.purpose,
      modelId: mount.modelId,
      connectionId: mount.connectionId,
      adapterId: mount.adapterId,
      externalModel: mount.externalModel,
    }))
    .sort((left, right) => `${left.agentId}:${left.purpose}`.localeCompare(`${right.agentId}:${right.purpose}`));
}
