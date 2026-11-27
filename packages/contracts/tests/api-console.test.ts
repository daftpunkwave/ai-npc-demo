/**
 * 验证控制台总览、装配、模型池、席位与剧情卡接口的 DTO。
 * 依赖公共契约包的 api-console 主题导出与共享固定样例。
 * 禁止启动控制台服务或读取真实配置文件；只校验 schema 形状。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assembliesResponseSchema,
  assemblyDetailResponseSchema,
  assemblyDiffEntrySchema,
  assemblyDraftRequestSchema,
  assemblyDraftResponseSchema,
  assemblyPreflightErrorSchema,
  assemblyPreflightRequestSchema,
  assemblyPreflightResponseSchema,
  assemblySourceSchema,
  clockStepRequestSchema,
  consoleBudgetSummarySchema,
  consoleFailureSummarySchema,
  consoleHealthResponseSchema,
  consoleModuleStatusSchema,
  consoleQueueSummarySchema,
  snapshotCreateRequestSchema,
  snapshotRestoreRequestSchema,
  snapshotRestoreResponseSchema,
  modelConfigDraftSchema,
  modelConnectionDraftSchema,
  modelConnectionViewSchema,
  modelEvaluatorDraftSchema,
  modelLayoutDraftRequestSchema,
  modelLayoutDraftResponseSchema,
  modelLayoutDraftSchema,
  modelLayoutRoutesResponseSchema,
  modelLayoutValidateRequestSchema,
  modelLayoutValidateResponseSchema,
  modelLayoutValidationErrorSchema,
  modelLayoutViewSchema,
  modelLayoutsResponseSchema,
  modelLimitsSchema,
  modelMountDraftSchema,
  modelProbeRequestSchema,
  modelProbeResponseSchema,
  moduleDescriptorViewSchema,
  modulesResponseSchema,
  resolvedRealmSetsSchema,
  restoreCheckSchema,
  restoreDryRunResponseSchema,
  runRequestApproveResponseSchema,
  runRequestDecisionRequestSchema,
  runRequestRejectResponseSchema,
  runRequestViewSchema,
  runRequestsResponseSchema,
  scenarioCardContentSchema,
  scenarioCardViewSchema,
  scenarioCardsResponseSchema,
  scenarioCompensateRequestSchema,
  scenarioCommandResponseSchema,
  scenarioDraftRequestSchema,
  scenarioDraftResponseSchema,
  scenarioOverrideRequestSchema,
  scenarioPreviewRequestSchema,
  scenarioPreviewResponseSchema,
  scenarioPublishRequestSchema,
  scenarioWithdrawRequestSchema,
  seatCommandRequestSchema,
  seatControllerKindSchema,
  seatHandoverRequestSchema,
  seatHandoverResponseSchema,
  seatInboxItemSchema,
  seatRenewRequestSchema,
  seatRenewResponseSchema,
  seatViewSchema,
  seatWorldViewResponseSchema,
  seatsResponseSchema,
  storageFootprintSchema,
} from "../src/index";
import {
  agentWorldViewFixture,
  agreementViewFixture,
  commandReceiptFixture,
  invitationViewFixture,
  resolvedModuleSetFixture,
} from "./fixtures";

const assembly = {
  schemaVersion: 1,
  assemblyId: "local-slg-standard-v1",
  configs: { clock: { secondsPerTick: 10 } },
  realms: {
    server: {
      bindings: [{ capability: "game.clock", moduleId: "game.clock.controlled", configRef: "clock" }],
    },
    client: { bindings: [] },
    console: { bindings: [] },
  },
};

const capabilityRef = { capability: "game.clock", cardinality: "exactly-one", instanceScope: "deployment" };

const resolvedSets = {
  server: resolvedModuleSetFixture("server"),
  client: resolvedModuleSetFixture("client"),
  console: resolvedModuleSetFixture("console"),
};

const capabilities = {
  toolCalling: true,
  strictTools: false,
  structuredOutput: "json_object",
  assistantReplay: "standard",
  contextWindowTokens: 64000,
  maxOutputTokens: 4096,
  embedding: false,
  embeddingDimensions: null,
};

const limits = { maxConcurrent: 2, requestsPerMinute: 20, tokensPerMinute: 40000, requestTimeoutMs: 30000 };

const modelConfig = {
  connectionId: "openai-compat",
  externalModel: "env:WORLD_PRISM_OPENAI_COMPAT_MODEL",
  parameters: { temperature: 0.6 },
  capabilities,
  limits,
  maxOutputTokensByPurpose: { decision: 1500, speech: 400 },
};

const modelLayoutDraft = {
  schemaVersion: 1,
  layoutId: "shared-model-layout-v1",
  connections: {
    "openai-compat": {
      adapterId: "platform.model-transport.openai-compatible",
      endpoint: "env:WORLD_PRISM_OPENAI_COMPAT_BASE_URL",
      credentialRef: "env:WORLD_PRISM_OPENAI_COMPAT_API_KEY",
      rateLimitKey: "openai-compat-account",
    },
  },
  models: { "npc-chat": modelConfig },
  mounts: [{ modelId: "npc-chat", agentIds: ["npc-cenyan"], purposes: ["decision"] }],
  evaluator: { enabled: false, principalId: "evaluator-judge", modelId: "npc-chat" },
};

const broadcastEffect = { kind: "broadcast", speakerId: "npc-shenli", text: "中继读数持续下降。" };

const scenarioCard = {
  cardId: "card-relay-alarm",
  version: 1,
  trigger: { atTick: 2 },
  effects: [broadcastEffect],
};

const consoleHealth = {
  status: "ready",
  ports: { client: 5173, server: 3000 },
  realms: ["server", "client", "console"],
  assemblyHash: "assembly-hash",
  modules: [{ moduleId: "game.clock.controlled", version: "1.0.0", status: "ready" }],
  clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
  queues: { turnsQueued: 0, turnsRunning: 0, maintenanceQueued: 0, modelQueue: 0 },
  laggingAgents: 0,
  budgets: [{ scope: "run", key: "tokens", used: 0, limit: null, unit: "tokens" }],
  recentFailures: [],
};

const storageFootprint = {
  measuredAt: "2026-11-18T00:00:00.000Z",
  databaseBytes: 4096 * 128,
  freeBytes: 4096,
  artifactBytes: { inline: 1024, file: 70_000 },
  tables: [{ table: "trace_spans", rows: 42 }],
  retention: [{ table: "trace_spans", days: 30 }],
};

/** 单条合法 + 非法样例的 DTO 表。 */
const dtoRows: ReadonlyArray<readonly [string, z.ZodType, unknown, unknown]> = [
  ["装配来源", assemblySourceSchema, "repo", "cache"],
  ["模块状态", consoleModuleStatusSchema, { moduleId: "game.clock.controlled", version: "1.0.0", status: "ready" }, { moduleId: "clock", version: "1", status: "started" }],
  ["队列摘要", consoleQueueSummarySchema, consoleHealth.queues, { ...consoleHealth.queues, turnsQueued: -1 }],
  ["预算摘要", consoleBudgetSummarySchema, consoleHealth.budgets[0], { scope: "run", key: "tokens", used: 0, limit: null, unit: "seconds" }],
  ["失败摘要", consoleFailureSummarySchema, { code: "provider-failed", safeMessage: "供应商失败", occurredAt: "2026-11-18T00:00:00.000Z", traceId: null }, { code: "nope", safeMessage: "x", occurredAt: "x", traceId: null }],
  ["控制台健康", consoleHealthResponseSchema, consoleHealth, { ...consoleHealth, laggingAgents: -1 }],
  ["控制台健康降级", consoleHealthResponseSchema, { ...consoleHealth, status: "degraded" }, { ...consoleHealth, status: "starting" }],
  ["存储占用", storageFootprintSchema, { ...storageFootprint, retention: [] }, { ...storageFootprint, retention: [{ table: "trace_spans", days: 0 }] }],
  ["控制台健康含存储占用", consoleHealthResponseSchema, { ...consoleHealth, storage: storageFootprint }, { ...consoleHealth, storage: { ...storageFootprint, freeBytes: -1 } }],
  ["控制台健康首轮存储测量未完成", consoleHealthResponseSchema, { ...consoleHealth, storage: null }, { ...consoleHealth, storage: {} }],
  ["存储占用拒绝未知字段", storageFootprintSchema, storageFootprint, { ...storageFootprint, walBytes: 0 }],
  [
    "模块描述",
    moduleDescriptorViewSchema,
    {
      moduleId: "game.clock.controlled",
      realm: "server",
      kind: "service",
      version: "1.0.0",
      apiVersion: "1",
      provides: [capabilityRef],
      requires: [],
      ownsAggregates: ["clock"],
      configJsonSchema: { type: "object" },
      experimentAxes: [],
    },
    { moduleId: "game.clock.controlled", realm: "server" },
  ],
  ["模块列表", modulesResponseSchema, { catalogHash: "catalog-hash", modules: [] }, { catalogHash: "catalog-hash" }],
  ["装配列表", assembliesResponseSchema, { assemblies: [{ assemblyId: "local-slg-standard-v1", source: "repo" }] }, { assemblies: [{ assemblyId: "x", source: "cache" }] }],
  ["三 realm 模块集", resolvedRealmSetsSchema, resolvedSets, { server: resolvedSets.server, client: resolvedSets.client }],
  ["装配详情", assemblyDetailResponseSchema, { descriptor: assembly, resolved: resolvedSets }, { descriptor: assembly, resolved: {} }],
  ["预检请求", assemblyPreflightRequestSchema, { assemblyRef: "assemblies/local-slg-standard-v1" }, { assemblyRef: "" }],
  ["预检错误", assemblyPreflightErrorSchema, { code: "capability-conflict", message: "能力冲突" }, { code: "", message: "x" }],
  ["装配差异项", assemblyDiffEntrySchema, { kind: "added", realm: "server", moduleId: "game.clock.controlled", capability: null }, { kind: "moved", realm: "server", moduleId: "game.clock.controlled", capability: null }],
  ["预检响应", assemblyPreflightResponseSchema, { ok: true, errors: [], resolved: resolvedSets, diffAgainstCurrent: [] }, { ok: false, errors: [], resolved: {}, diffAgainstCurrent: [] }],
  ["装配草稿请求", assemblyDraftRequestSchema, { assembly }, { assembly: { ...assembly, schemaVersion: 0 } }],
  ["装配草稿响应", assemblyDraftResponseSchema, { assemblyId: "local-slg-standard-v1", version: 2 }, { assemblyId: "local-slg-standard-v1", version: 0 }],
  [
    "模型连接草稿",
    modelConnectionDraftSchema,
    { adapterId: "platform.model-transport.anthropic", credentialRef: "env:ANTHROPIC_API_KEY", rateLimitKey: "anthropic-account" },
    { adapterId: "anthropic" },
  ],
  ["模型限制", modelLimitsSchema, limits, { ...limits, maxConcurrent: 0 }],
  ["模型配置", modelConfigDraftSchema, modelConfig, { ...modelConfig, limits: { ...limits, tokensPerMinute: -1 } }],
  ["模型挂载", modelMountDraftSchema, { modelId: "npc-chat", agentIds: ["npc-cenyan"], purposes: ["decision"] }, { modelId: "npc-chat", agentIds: [], purposes: ["decision"] }],
  ["evaluator 配置", modelEvaluatorDraftSchema, { enabled: false, principalId: "evaluator-judge", modelId: "npc-chat" }, { enabled: "no", principalId: "evaluator-judge", modelId: "npc-chat" }],
  ["模型布局草稿", modelLayoutDraftSchema, modelLayoutDraft, { ...modelLayoutDraft, mounts: [{ modelId: "npc-chat", agentIds: [], purposes: [] }] }],
  [
    "模型连接视图",
    modelConnectionViewSchema,
    { adapterId: "platform.model-transport.openai-compatible", endpointRef: "env:WORLD_PRISM_OPENAI_COMPAT_BASE_URL", endpointHost: "api.deepseek.com", credentialRef: "env:WORLD_PRISM_OPENAI_COMPAT_API_KEY", rateLimitKey: "openai-compat-account" },
    { adapterId: "openai", endpointRef: null, endpointHost: null, credentialRef: null, rateLimitKey: null },
  ],
  ["模型布局视图", modelLayoutViewSchema, { ...modelLayoutDraft, connections: { "openai-compat": { adapterId: "platform.model-transport.openai-compatible", endpointRef: "env:WORLD_PRISM_OPENAI_COMPAT_BASE_URL", endpointHost: "api.deepseek.com", credentialRef: "env:WORLD_PRISM_OPENAI_COMPAT_API_KEY", rateLimitKey: "openai-compat-account" } } }, { ...modelLayoutDraft, connections: { "openai-compat": { adapterId: "bad" } } }],
  ["模型布局列表", modelLayoutsResponseSchema, { layouts: [{ layoutId: "shared-model-layout-v1", source: "repo" }] }, { layouts: [{ layoutId: "x", source: "cache" }] }],
  ["模型路由", modelLayoutRoutesResponseSchema, { routes: [{ agentId: "npc-cenyan", purpose: "decision", modelId: "npc-chat", connectionId: "openai-compat", adapterId: "platform.model-transport.openai-compatible", externalModel: "deepseek-chat" }] }, { routes: [{ agentId: "npc-cenyan", purpose: "chat", modelId: "npc-chat", connectionId: "openai-compat", adapterId: "platform.model-transport.openai-compatible", externalModel: "deepseek-chat" }] }],
  ["布局校验请求", modelLayoutValidateRequestSchema, { layout: null }, {}],
  ["布局校验错误", modelLayoutValidationErrorSchema, { code: "unknown-model", message: "未知模型" }, { code: "", message: "x" }],
  ["布局校验响应", modelLayoutValidateResponseSchema, { ok: true, errors: [] }, { ok: true, errors: [{ code: "x" }] }],
  ["布局草稿请求", modelLayoutDraftRequestSchema, { layout: modelLayoutDraft }, { layout: {} }],
  ["布局草稿响应", modelLayoutDraftResponseSchema, { layoutId: "shared-model-layout-v1", version: 2 }, { layoutId: "", version: 2 }],
  ["模型探测请求", modelProbeRequestSchema, { modelId: "npc-chat", operationId: "op-k3j9x0a1b2c3" }, { modelId: "npc-chat" }],
  ["模型探测响应", modelProbeResponseSchema, { ok: true, latencyMs: 120, servedModel: "deepseek-chat" }, { ok: true, latencyMs: -1 }],
  // 脚本控制只属于实验分支，席位接口既不呈现也不接受。
  ["席位控制者", seatControllerKindSchema, "human", "script"],
  ["席位视图", seatViewSchema, { agentId: "species-fauna", controllerKind: "agent", controllerPrincipalId: "species-fauna", controllerEpoch: 0, leaseExpiresAt: "2026-11-18T00:10:00.000Z" }, { agentId: "species-fauna", controllerKind: "agent" }],
  ["席位列表", seatsResponseSchema, { seats: [] }, { seats: [{}] }],
  ["席位交接请求", seatHandoverRequestSchema, { operationId: "op-k3j9x0a1b2c3", mode: "human", expectedEpoch: 0, reason: "接管" }, { operationId: "op-k3j9x0a1b2c3", mode: "script", expectedEpoch: 0, reason: "接管" }],
  ["席位交接响应", seatHandoverResponseSchema, { controllerEpoch: 1, controllerKind: "human", leaseExpiresAt: "2026-11-18T00:10:00.000Z" }, { controllerEpoch: -1, controllerKind: "human", leaseExpiresAt: "x" }],
  ["席位续期请求", seatRenewRequestSchema, { controllerEpoch: 1 }, { controllerEpoch: -1 }],
  ["席位续期响应", seatRenewResponseSchema, { leaseExpiresAt: "2026-11-18T00:10:00.000Z" }, {}],
  ["席位收件项", seatInboxItemSchema, { kind: "dialogue", fromId: "player-1", text: "你好", worldTick: 0 }, { kind: "sms", fromId: "player-1", text: "你好", worldTick: 0 }],
  [
    "席位世界视图",
    seatWorldViewResponseSchema,
    { worldView: agentWorldViewFixture(), inbox: [], agreements: [agreementViewFixture()], invitations: [invitationViewFixture()] },
    { worldView: agentWorldViewFixture(), inbox: [] },
  ],
  ["席位命令", seatCommandRequestSchema, { commandId: "cmd-k3j9x0a1b2c3", type: "policy.set", schemaVersion: 1, payload: { key: "watergate.allocation", value: "rotation" } }, { commandId: "cmd-1", type: "policy.set", schemaVersion: 1, payload: {} }],
  ["单步请求", clockStepRequestSchema, { operationId: "op-k3j9x0a1b2c3", expectedRunVersion: 1, ticks: 6 }, { operationId: "op-k3j9x0a1b2c3", expectedRunVersion: 1, ticks: 25 }],
  ["运营快照请求", snapshotCreateRequestSchema, { operationId: "op-k3j9x0a1b2c3", label: "检查点" }, { label: "检查点" }],
  ["恢复检查项", restoreCheckSchema, { name: "manifest", ok: true, message: null }, { name: "", ok: true, message: null }],
  ["恢复试运行响应", restoreDryRunResponseSchema, { ok: true, checks: [] }, { ok: true }],
  ["恢复生效响应", snapshotRestoreResponseSchema, { branchId: "br-k3j9x0a1b2c3", clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 1 } }, { branchId: "br-1", clock: {} }],
      ["run 申请视图", runRequestViewSchema, { requestId: "rr-k3j9x0a1b2c3", presetId: "s-promise", note: "", status: "pending", createdAt: "2026-11-18T00:00:00.000Z" }, { requestId: "rr-1", presetId: "s-promise", note: "", status: "pending", createdAt: "x" }],
  ["run 申请列表", runRequestsResponseSchema, { requests: [] }, { requests: [{}] }],
  ["run 申请决定请求", runRequestDecisionRequestSchema, { note: "批准" }, { note: 1 }],
  ["run 申请批准响应", runRequestApproveResponseSchema, { runId: "run-k3j9x0a1b2c3" }, { runId: "run-1" }],
  ["run 申请拒绝响应", runRequestRejectResponseSchema, { ok: true }, { ok: false }],
  ["剧情卡内容", scenarioCardContentSchema, scenarioCard, { ...scenarioCard, effects: [] }],
  ["剧情卡视图", scenarioCardViewSchema, { cardId: "card-relay-alarm", version: 1, source: "builtin", triggerAtTick: 2, effects: [broadcastEffect], status: "published", triggeredAtTick: null }, { cardId: "card-relay-alarm", version: 1, source: "builtin", triggerAtTick: 2, effects: [broadcastEffect], status: "scheduled", triggeredAtTick: null }],
  ["剧情卡列表", scenarioCardsResponseSchema, { cards: [] }, { cards: [{}] }],
  ["剧情卡草稿请求", scenarioDraftRequestSchema, { card: scenarioCard }, { card: { ...scenarioCard, cardId: "relay" } }],
  ["剧情卡草稿响应", scenarioDraftResponseSchema, { cardId: "card-relay-alarm", version: 2 }, { cardId: "card-relay-alarm", version: 0 }],
  ["剧情卡预览请求", scenarioPreviewRequestSchema, { version: 2, atTick: 6 }, { version: 0, atTick: 6 }],
  ["剧情卡预览响应", scenarioPreviewResponseSchema, { events: [{ type: "CampaignStarted", audience: [{ kind: "public" }], payload: {}, summaryZh: "开始。" }] }, { events: [{}] }],
  ["剧情卡发布请求", scenarioPublishRequestSchema, { version: 2, triggerAtTick: 6, operationId: "op-k3j9x0a1b2c3" }, { version: 2, triggerAtTick: -1, operationId: "op-k3j9x0a1b2c3" }],
  ["剧情卡撤回请求", scenarioWithdrawRequestSchema, { operationId: "op-k3j9x0a1b2c3" }, {}],
  ["剧情卡补偿请求", scenarioCompensateRequestSchema, { effects: [broadcastEffect], note: "补偿", operationId: "op-k3j9x0a1b2c3" }, { effects: [], note: "补偿", operationId: "op-k3j9x0a1b2c3" }],
  ["剧情卡覆盖请求", scenarioOverrideRequestSchema, { effects: [{ kind: "meter-set", meter: "relay.stability", value: 45 }], note: "调试", operationId: "op-k3j9x0a1b2c3" }, { effects: [{ kind: "meter-set", meter: "watergate.allocation", value: 45 }], note: "调试", operationId: "op-k3j9x0a1b2c3" }],
  ["剧情卡命令响应", scenarioCommandResponseSchema, commandReceiptFixture(), { ...commandReceiptFixture(), commandId: "cmd-1" }],
];

describe("控制台接口 DTO", () => {
  it("装配详情与预检组合样例", () => {
    expect(assemblyDetailResponseSchema.safeParse({ descriptor: assembly, resolved: resolvedSets }).success).toBe(true);
  });

  it("每类请求与响应 DTO 都有合法与非法样例", () => {
    for (const [name, schema, valid, invalid] of dtoRows) {
      expect(schema.safeParse(valid).success, `${name} 应接受合法样例`).toBe(true);
      expect(schema.safeParse(invalid).success, `${name} 应拒绝非法样例`).toBe(false);
    }
  });

  it("恢复请求的 dryRun 可省略，显式给出时必须为布尔值", () => {
    const base = { operationId: "op-k3j9x0a1b2c3", snapshotId: "snap-k3j9x0a1b2c3" };
    // 省略 dryRun 表示真正恢复，与已实现路由的 `.strict()` 解析一致。
    expect(snapshotRestoreRequestSchema.safeParse(base).success).toBe(true);
    expect(snapshotRestoreRequestSchema.safeParse({ ...base, dryRun: true }).success).toBe(true);
    expect(snapshotRestoreRequestSchema.safeParse({ ...base, dryRun: false }).success).toBe(true);
    expect(snapshotRestoreRequestSchema.safeParse({ ...base, dryRun: "yes" }).success).toBe(false);
    // 未知字段一律拒绝，避免客户端按旧契约多传字段时被静默忽略。
    expect(snapshotRestoreRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("恢复预检与生效是两份独立响应契约", () => {
    const clock = { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 1 };
    const preview = { ok: true, checks: [{ name: "manifest", ok: true, message: null }] };
    const applied = { branchId: "br-k3j9x0a1b2c3", clock };
    // 预检结果只满足预检契约，生效结果只满足生效契约，不存在可被互相误判的重叠形状。
    expect(restoreDryRunResponseSchema.safeParse(preview).success).toBe(true);
    expect(snapshotRestoreResponseSchema.safeParse(preview).success).toBe(false);
    expect(snapshotRestoreResponseSchema.safeParse(applied).success).toBe(true);
    expect(restoreDryRunResponseSchema.safeParse(applied).success).toBe(false);
  });
});
