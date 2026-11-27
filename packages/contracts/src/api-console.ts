/**
 * 定义控制台总览、模块装配、模型池、三势力席位与剧情卡接口的 DTO。
 * 依赖装配与模型契约、投影类型、存储占用测量、命令回执与事件预览；不包含可观测与评估接口。
 * 禁止在此实现鉴权、装配解析或剧情效果，只在契约层描述请求与响应形状。
 */
import { z } from "zod";
import { errorCodeSchema } from "./errors";
import { idSchemas, principalIdSchema } from "./ids";
import { jsonValueSchema } from "./json";
import { modelCapabilitiesSchema, modelPurposeSchema } from "./model";
import {
  assemblyDescriptorSchema,
  capabilityIdSchema,
  capabilityRefSchema,
  moduleIdSchema,
  moduleKindSchema,
  realmSchema,
  resolvedModuleSetSchema,
} from "./modules";
import { clockViewSchema } from "./projection";
import { storageFootprintSchema } from "./storage";

/** 装配来源：仓库文件或控制台草稿。 */
export const assemblySourceSchema = z.enum(["repo", "draft"]);

export type AssemblySource = z.infer<typeof assemblySourceSchema>;

/** 健康摘要的整体状态；与 `/api/v1/health` 使用同一取值来源。 */
export const consoleHealthStatusSchema = z.enum(["ready", "degraded"]);

export type ConsoleHealthStatus = z.infer<typeof consoleHealthStatusSchema>;

/** 控制台健康摘要中的模块状态；取值来自装配与启动结果。 */
export const consoleModuleStatusSchema = z
  .object({
    moduleId: moduleIdSchema,
    version: z.string().min(1),
    status: consoleHealthStatusSchema,
  })
  .strict();

/** 队列摘要；尚无数据来源的字段留空，不用 0 冒充。 */
export const consoleQueueSummarySchema = z
  .object({
    turnsQueued: z.number().int().nonnegative(),
    turnsRunning: z.number().int().nonnegative().optional(),
    maintenanceQueued: z.number().int().nonnegative().optional(),
    /** 失败次数已达上限、不会再被认领的维护任务数；与「仍在排队」分开计数。 */
    maintenanceExhausted: z.number().int().nonnegative().optional(),
    modelQueue: z.number().int().nonnegative().optional(),
  })
  .strict();

/** 预算摘要：scope 与 unit 固定，具体 key 由预算模块登记。 */
export const consoleBudgetSummarySchema = z
  .object({
    scope: z.enum(["run", "agent", "turn", "purpose"]),
    key: z.string().min(1),
    used: z.number().nonnegative(),
    limit: z.number().nonnegative().nullable(),
    unit: z.enum(["tokens", "cost", "calls"]),
  })
  .strict();

export const consoleFailureSummarySchema = z
  .object({
    code: errorCodeSchema,
    safeMessage: z.string().min(1),
    occurredAt: z.string().min(1),
    traceId: z.string().min(1).nullable(),
  })
  .strict();

/**
 * 热路径耗时：宿主 tracer 在进程内按 span 名称汇总，只在内存中保存，进程重启后清零。
 * count 与 errors 自进程启动累计；百分位与最大值只统计最近 samples 个样本，单位毫秒。
 */
export const consoleHotPathTimingSchema = z
  .object({
    name: z.string().min(1),
    count: z.number().int().positive(),
    errors: z.number().int().nonnegative(),
    samples: z.number().int().positive(),
    lastMs: z.number().nonnegative(),
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
  })
  .strict();

export type ConsoleHotPathTiming = z.infer<typeof consoleHotPathTimingSchema>;

/** 控制台运行总览；与 console.health 频道推送的内容同构。 */
export const consoleHealthResponseSchema = z
  .object({
    status: consoleHealthStatusSchema,
    ports: z
      .object({
        client: z.number().int().positive(),
        server: z.number().int().positive(),
      })
      .strict(),
    realms: z.array(realmSchema),
    assemblyHash: z.string().min(1),
    modules: z.array(consoleModuleStatusSchema),
    clock: clockViewSchema,
    queues: consoleQueueSummarySchema,
    /** 存储占用测量：null 表示首轮后台测量尚未完成；存储实现不提供测量时省略。 */
    storage: storageFootprintSchema.nullable().optional(),
    laggingAgents: z.number().int().nonnegative().optional(),
    budgets: z.array(consoleBudgetSummarySchema),
    recentFailures: z.array(consoleFailureSummarySchema),
    /** 宿主未接入耗时汇总时省略，不用空数组冒充「没有热路径」。 */
    hotPaths: z.array(consoleHotPathTimingSchema).optional(),
  })
  .strict();

export type ConsoleHealthResponse = z.infer<typeof consoleHealthResponseSchema>;

/** 模块描述视图：面向控制台展示，不含工厂与实现。 */
export const moduleDescriptorViewSchema = z
  .object({
    moduleId: moduleIdSchema,
    realm: realmSchema,
    kind: moduleKindSchema,
    version: z.string().min(1),
    apiVersion: z.string().min(1),
    provides: z.array(capabilityRefSchema),
    requires: z.array(capabilityRefSchema),
    ownsAggregates: z.array(z.string().min(1)),
    configJsonSchema: jsonValueSchema,
    experimentAxes: z.array(
      z
        .object({
          key: z.string().min(1),
          label: z.string().min(1),
          values: z.array(jsonValueSchema).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type ModuleDescriptorView = z.infer<typeof moduleDescriptorViewSchema>;

export const modulesResponseSchema = z
  .object({
    catalogHash: z.string().min(1),
    modules: z.array(moduleDescriptorViewSchema),
  })
  .strict();

export type ModulesResponse = z.infer<typeof modulesResponseSchema>;

export const assembliesResponseSchema = z
  .object({
    assemblies: z.array(
      z.object({ assemblyId: z.string().min(1), source: assemblySourceSchema }).strict(),
    ),
  })
  .strict();

/** 三个 realm 的已解析模块集。 */
export const resolvedRealmSetsSchema = z
  .object({
    server: resolvedModuleSetSchema,
    client: resolvedModuleSetSchema,
    console: resolvedModuleSetSchema,
  })
  .strict();

export const assemblyDetailResponseSchema = z
  .object({
    descriptor: assemblyDescriptorSchema,
    resolved: resolvedRealmSetsSchema,
  })
  .strict();

export type AssemblyDetailResponse = z.infer<typeof assemblyDetailResponseSchema>;

export const assemblyPreflightRequestSchema = z.union([
  z.object({ assembly: assemblyDescriptorSchema }).strict(),
  z.object({ assemblyRef: z.string().min(1) }).strict(),
]);

export type AssemblyPreflightRequest = z.infer<typeof assemblyPreflightRequestSchema>;

export const assemblyPreflightErrorSchema = z
  .object({
    code: z.string().min(1),
    moduleId: moduleIdSchema.optional(),
    capability: capabilityIdSchema.optional(),
    message: z.string().min(1),
  })
  .strict();

export const assemblyDiffEntrySchema = z
  .object({
    kind: z.enum(["added", "removed", "changed"]),
    realm: realmSchema,
    moduleId: moduleIdSchema.nullable(),
    capability: capabilityIdSchema.nullable(),
  })
  .strict();

export const assemblyPreflightResponseSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(assemblyPreflightErrorSchema),
    resolved: resolvedRealmSetsSchema,
    diffAgainstCurrent: z.array(assemblyDiffEntrySchema),
  })
  .strict();

export const assemblyDraftRequestSchema = z
  .object({
    assembly: assemblyDescriptorSchema,
  })
  .strict();

export const assemblyDraftResponseSchema = z
  .object({
    assemblyId: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();

/** 模型连接草稿：保留引用名与受控 endpoint，不包含解析后的密钥。 */
export const modelConnectionDraftSchema = z
  .object({
    adapterId: moduleIdSchema,
    endpoint: z.string().min(1).optional(),
    credentialRef: z.string().min(1).optional(),
    rateLimitKey: z.string().min(1).optional(),
    fixtureFiles: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** 模型配额与超时限制。 */
export const modelLimitsSchema = z
  .object({
    maxConcurrent: z.number().int().positive(),
    requestsPerMinute: z.number().int().positive(),
    tokensPerMinute: z.number().int().positive(),
    requestTimeoutMs: z.number().int().positive(),
  })
  .strict();

/** 一个模型最多声明的供应商返回名别名数。 */
export const maxServedModelAliases = 16;

/**
 * 供应商返回名别名：有的网关按请求名路由，却在响应里报告上游名称，声明后这些响应不算模型替换。
 * 写成名称列表，或写成 `env:` 引用（由宿主预检时解析逗号分隔的列表）；仓库布局文件、控制台草稿与查看共用这一份定义。
 */
export const servedModelsSchema = z.union([
  z.string().regex(/^env:/u),
  z.array(z.string().min(1)).min(1).max(maxServedModelAliases)
    .refine((names) => new Set(names).size === names.length, { message: "servedModels 不得重复" }),
]);

export const modelConfigDraftSchema = z
  .object({
    connectionId: z.string().min(1),
    externalModel: z.string().min(1),
    /** 未声明时省略，与仓库布局文件的写法一致。 */
    servedModels: servedModelsSchema.optional(),
    parameters: jsonValueSchema,
    capabilities: modelCapabilitiesSchema,
    limits: modelLimitsSchema,
    maxOutputTokensByPurpose: z.record(z.string().min(1), z.number().int().positive()),
  })
  .strict();

export const modelMountDraftSchema = z
  .object({
    modelId: z.string().min(1),
    agentIds: z.array(principalIdSchema).min(1).max(64),
    purposes: z.array(modelPurposeSchema).min(1).max(8),
  })
  .strict();

export const modelEvaluatorDraftSchema = z
  .object({
    enabled: z.boolean(),
    principalId: principalIdSchema,
    modelId: z.string().min(1),
  })
  .strict();

/** 模型布局草稿：连接、模型、挂载与 evaluator。 */
export const modelLayoutDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    layoutId: z.string().min(1),
    connections: z.record(z.string().min(1), modelConnectionDraftSchema),
    models: z.record(z.string().min(1), modelConfigDraftSchema),
    mounts: z.array(modelMountDraftSchema).max(128),
    evaluator: modelEvaluatorDraftSchema.optional(),
  })
  .strict();

export type ModelLayoutDraft = z.infer<typeof modelLayoutDraftSchema>;

/** 去密钥连接视图：公开主机名和端点引用，凭据只显示引用名。 */
export const modelConnectionViewSchema = z
  .object({
    adapterId: moduleIdSchema,
    endpointRef: z.string().min(1).nullable(),
    endpointHost: z.string().min(1).nullable(),
    credentialRef: z.string().min(1).nullable(),
    rateLimitKey: z.string().min(1).nullable(),
  })
  .strict();

export const modelLayoutViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    layoutId: z.string().min(1),
    connections: z.record(z.string().min(1), modelConnectionViewSchema),
    models: z.record(z.string().min(1), modelConfigDraftSchema),
    mounts: z.array(modelMountDraftSchema),
    evaluator: modelEvaluatorDraftSchema.optional(),
  })
  .strict();

export type ModelLayoutView = z.infer<typeof modelLayoutViewSchema>;

export const modelLayoutsResponseSchema = z
  .object({
    layouts: z.array(z.object({ layoutId: z.string().min(1), source: assemblySourceSchema }).strict()),
  })
  .strict();

export type ModelLayoutsResponse = z.infer<typeof modelLayoutsResponseSchema>;

export const modelLayoutRoutesResponseSchema = z
  .object({
    routes: z.array(
      z
        .object({
          agentId: principalIdSchema,
          purpose: modelPurposeSchema,
          modelId: z.string().min(1),
          connectionId: z.string().min(1),
          adapterId: moduleIdSchema,
          externalModel: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type ModelLayoutRoutesResponse = z.infer<typeof modelLayoutRoutesResponseSchema>;

export const modelLayoutValidateRequestSchema = z
  .object({
    layout: jsonValueSchema,
  })
  .strict();

export const modelLayoutValidationErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

export const modelLayoutValidateResponseSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(modelLayoutValidationErrorSchema),
  })
  .strict();

export type ModelLayoutValidateResponse = z.infer<typeof modelLayoutValidateResponseSchema>;

export const modelLayoutDraftRequestSchema = z
  .object({
    layout: modelLayoutDraftSchema,
  })
  .strict();

export const modelLayoutDraftResponseSchema = z
  .object({
    layoutId: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();

export const modelProbeRequestSchema = z
  .object({
    modelId: z.string().min(1),
    operationId: idSchemas.op,
  })
  .strict();

export const modelProbeResponseSchema = z
  .object({
    ok: z.boolean(),
    latencyMs: z.number().nonnegative(),
    servedModel: z.string().min(1).nullable(),
    error: z.object({ kind: z.string().min(1), message: z.string() }).strict().optional(),
  })
  .strict();
