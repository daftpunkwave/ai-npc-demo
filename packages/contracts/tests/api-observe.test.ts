/**
 * 验证控制台可观测、调试、评估、run 与导出接口的 DTO。
 * 依赖公共契约包的 api-observe 主题导出与共享固定样例。
 * 禁止读取真实证据档案或调用模型；只校验查询与返回形状。
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentCommitmentViewSchema,
  agentInspectorQuerySchema,
  agentInspectorResponseSchema,
  agentRelationViewSchema,
  agentStatusViewSchema,
  agentsQuerySchema,
  agentsResponseSchema,
  artifactQuerySchema,
  artifactResponseSchema,
  branchCompareQuerySchema,
  branchCompareResponseSchema,
  branchDiffKindSchema,
  branchDifferenceSchema,
  debugQueuesResponseSchema,
  debugWakeRequestSchema,
  debugWakeResponseSchema,
  experimentCellSummarySchema,
  experimentCreateRequestSchema,
  experimentCreateResponseSchema,
  experimentDetailResponseSchema,
  experimentMetricSummarySchema,
  exportRequestSchema,
  exportResponseSchema,
  memoryDiffEntrySchema,
  memoryDiffQuerySchema,
  memoryDiffResponseSchema,
  memoryQuerySchema,
  memoryResponseSchema,
  memoryWatermarkViewSchema,
  observationsQuerySchema,
  observationsResponseSchema,
  queueSummarySchema,
  replayDifferenceSchema,
  reportBehaviorSchema,
  reportCostSchema,
  reportLatencySchema,
  reportMemorySchema,
  reportMetricSchema,
  reportProbeSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  runDetailResponseSchema,
  runReportResponseSchema,
  runSpecSchema,
  runStatusChangeRequestSchema,
  runStatusResponseSchema,
  runSummarySchema,
  runValiditySchema,
  runValidationErrorSchema,
  runsQuerySchema,
  runsResponseSchema,
  timelineQuerySchema,
  timelineResponseSchema,
  traceResponseSchema,
  traceSpanSchema,
  turnAttemptViewSchema,
  turnDetailSchema,
  turnReplayResponseSchema,
  turnStageViewSchema,
  turnSummarySchema,
  turnToolCallViewSchema,
  turnsQuerySchema,
  turnsResponseSchema,
} from "../src/index";
import {
  agentWorldViewFixture,
  memoryRecordFixture,
  observationFixture,
  turnDetailFixture,
  turnSummaryFixture,
} from "./fixtures";

const timelineItem = {
  kind: "lifecycle",
  worldSeq: null,
  worldTick: 0,
  eventId: null,
  type: "module.started",
  principalId: null,
  audience: null,
  summaryZh: "模块已启动。",
  payload: {},
  correlationId: null,
  createdAt: "2026-11-18T00:00:00.000Z",
};

const inspector = {
  agentId: "npc-cenyan",
  persona: { role: "守备官", values: ["重兑现"] },
  location: "pass",
  worldView: agentWorldViewFixture(),
  memoryRevision: 7,
  memoryRecords: [memoryRecordFixture()],
  relations: [{ targetId: "npc-shenli", label: "同僚", trust: 2 }],
  commitments: [
    {
      kind: "agreement",
      refId: "agr-k3j9x0a1b2c3",
      summary: "在 tick 48 前护送道路",
      dueTick: 48,
      state: "open",
    },
  ],
  watermarks: { observationSeq: 12, perceptionRevision: 4, memoryRevision: 7, derivedThroughTick: 3 },
  recentTurns: [turnSummaryFixture()],
};

const runSummary = {
  runId: "run-k3j9x0a1b2c3",
  status: "completed",
  variant: "memory-m1-structured-ledger",
  contaminated: false,
  createdAt: "2026-11-18T00:00:00.000Z",
};

const report = {
  runId: "run-k3j9x0a1b2c3",
  variant: "memory-m1-structured-ledger",
  scriptId: "s-promise",
  scriptBranch: "break",
  validity: { valid: true, contaminated: false, evidenceComplete: true, invalidReasons: [] },
  metrics: [{ metric: "recall-accuracy", numerator: 1, denominator: 1, value: 1 }],
  probes: [
    {
      probeId: "p-recall-promise",
      agentId: "npc-cenyan",
      answer: "我答应过。",
      score: { kind: "recall", correct: true },
      valid: true,
    },
  ],
  behavior: [
    {
      atTick: 60,
      agentId: "npc-cenyan",
      trigger: "player-dialogue",
      stance: "decline",
      reasonCode: "past-breach",
      commands: [],
    },
  ],
  memory: { recordsByTier: { short: 12, long: 5, core: 1 }, maintenanceRuns: 2, maintenanceFailures: 0 },
  cost: {
    inputTokens: 12000,
    outputTokens: 3000,
    unknownUsageAttempts: 0,
    costEstimate: 0,
    currency: "USD",
    pricingVersion: "2026-11",
  },
  latency: { turnP50Ms: 4200, turnP95Ms: 9100 },
};

const trace = {
  traceId: "trc-k3j9x0a1b2c3",
  root: {
    spanId: "spn-k3j9x0a1b2c3",
    traceId: "trc-k3j9x0a1b2c3",
    parentSpanId: null,
    name: "turn",
    attrs: { agentId: "npc-cenyan" },
    startedAt: "2026-11-18T00:00:00.000Z",
    durationMs: 120,
    children: [
      {
        spanId: "spn-k3j9x0a1b2c4",
        traceId: "trc-k3j9x0a1b2c3",
        parentSpanId: "spn-k3j9x0a1b2c3",
        name: "model.attempt",
        attrs: { purpose: "decision" },
        startedAt: "2026-11-18T00:00:00.010Z",
        durationMs: 100,
        children: [],
      },
    ],
  },
};

/** 单条合法 + 非法样例的 DTO 表。 */
const dtoRows: ReadonlyArray<readonly [string, z.ZodType, unknown, unknown]> = [
  ["时间线查询", timelineQuerySchema, { fromSeq: 0, limit: 200, types: ["CampaignStarted"] }, { fromSeq: 0, limit: 201 }],
  ["时间线响应", timelineResponseSchema, { events: [timelineItem] }, { events: [{}] }],
  ["Agent 列表项", agentStatusViewSchema, { agentId: "npc-cenyan", kind: "character", active: true, controllerKind: "agent", location: "pass", turnStatus: "idle", watermarkLag: 0 }, { agentId: "npc-cenyan", kind: "npc", active: true, controllerKind: "agent", location: null, turnStatus: "idle", watermarkLag: 0 }],
  ["Agent 列表", agentsResponseSchema, { agents: [] }, { agents: [{}] }],
  ["Agent 查询", agentsQuerySchema, { branchId: "br-k3j9x0a1b2c3" }, {}],
  ["关系视图", agentRelationViewSchema, { targetId: "npc-shenli", label: "同僚", trust: 2 }, { targetId: "npc-shenli", label: "同僚", trust: 3 }],
  ["承诺视图", agentCommitmentViewSchema, inspector.commitments[0], { kind: "promise", refId: "", summary: "x", dueTick: null, state: "open" }],
  ["水位视图", memoryWatermarkViewSchema, inspector.watermarks, { observationSeq: -1, perceptionRevision: 0, memoryRevision: 0, derivedThroughTick: 0 }],
  ["Agent 检查器", agentInspectorResponseSchema, inspector, { ...inspector, watermarkLag: 1 }],
  ["检查器查询", agentInspectorQuerySchema, { branchId: "br-k3j9x0a1b2c3" }, { branchId: "" }],
  ["记忆查询", memoryQuerySchema, { branchId: "br-k3j9x0a1b2c3", revision: 7 }, { branchId: "br-k3j9x0a1b2c3", revision: -1 }],
  ["记忆响应", memoryResponseSchema, { revision: 7, records: [memoryRecordFixture()] }, { revision: 7, records: [{}] }],
  ["记忆差异项", memoryDiffEntrySchema, { memoryId: "mem-k3j9x0a1b2c3", sourceObservationIds: ["obs-k3j9x0a1b2c3"] }, { memoryId: "mem-1", sourceObservationIds: [] }],
  ["记忆差异", memoryDiffResponseSchema, { added: [], retired: [], changed: [] }, { added: [] }],
  ["记忆差异查询", memoryDiffQuerySchema, { branchId: "br-k3j9x0a1b2c3", from: 1, to: 7 }, { branchId: "br-k3j9x0a1b2c3", from: 7, to: 1 }],
  ["观察查询", observationsQuerySchema, { branchId: "br-k3j9x0a1b2c3", fromSeq: 0, limit: 50 }, { branchId: "br-k3j9x0a1b2c3", fromSeq: 0 }],
  ["观察响应", observationsResponseSchema, { observations: [observationFixture()] }, { observations: [{}] }],
  ["turn 摘要", turnSummarySchema, turnSummaryFixture(), { ...turnSummaryFixture(), turnId: "turn-1" }],
  ["turn 阶段", turnStageViewSchema, turnDetailFixture().stages[0], { stage: "context", status: "pending", reason: null, requested: {}, resolved: {}, effective: {}, spanId: "spn-k3j9x0a1b2c3" }],
  ["turn 尝试", turnAttemptViewSchema, turnDetailFixture().attempts[0], { ...turnDetailFixture().attempts[0], attemptId: "attempt-1" }],
  ["turn 工具调用", turnToolCallViewSchema, { toolCallId: "tc-1", toolId: "world.inspect", executionStatus: "ok", commandStatus: null, rawArtifactId: null, viewArtifactId: null, operationId: null }, { toolCallId: "tc-1", toolId: "world.inspect", executionStatus: "done", commandStatus: null, rawArtifactId: null, viewArtifactId: null, operationId: null }],
  ["turn 详情", turnDetailSchema, turnDetailFixture(), { ...turnDetailFixture(), traceId: "trace-1" }],
  ["turn 查询", turnsQuerySchema, { runId: "run-k3j9x0a1b2c3", status: "completed", limit: 20 }, { runId: "run-1" }],
  ["turn 列表", turnsResponseSchema, { turns: [turnSummaryFixture()] }, { turns: [{}] }],
  ["artifact 查询", artifactQuerySchema, { view: "raw" }, { view: "full" }],
  ["artifact 响应", artifactResponseSchema, { artifactId: "art-k3j9x0a1b2c3", view: "redacted", body: "内容" }, { artifactId: "art-1", view: "redacted", body: "内容" }],
  ["span 树", traceSpanSchema, trace.root, { ...trace.root, spanId: "span-1" }],
  ["trace 响应", traceResponseSchema, trace, { traceId: "trc-k3j9x0a1b2c3", root: {} }],
  ["分支差异类型", branchDiffKindSchema, "meter", "turn"],
  ["分支差异项", branchDifferenceSchema, { kind: "meter", key: "relay.stability", left: 45, right: 42 }, { kind: "meter", key: "relay.stability" }],
  ["分支对比查询", branchCompareQuerySchema, { left: "br-1", right: "br-2", atSeq: 10 }, { left: "br-1", right: "br-2", atSeq: -1 }],
  ["分支对比响应", branchCompareResponseSchema, { left: "br-1", right: "br-2", atSeq: 10, differences: [] }, { left: "br-1", right: "br-2", atSeq: 10 }],
  ["队列摘要", queueSummarySchema, { queued: 0, running: 1, oldestAt: null }, { queued: 0, running: -1, oldestAt: null }],
  ["调试队列", debugQueuesResponseSchema, { scheduler: { queued: 0, running: 0, oldestAt: null }, modelPool: { queued: 0, running: 0, oldestAt: null }, maintenance: { queued: 0, running: 0, oldestAt: null } }, { scheduler: { queued: 0, running: 0, oldestAt: null } }],
  ["重放差异", replayDifferenceSchema, { path: "messages[0].content", expected: "a", actual: "b" }, { path: "", expected: "a", actual: "b" }],
  ["turn 重放响应", turnReplayResponseSchema, { requestHashMatch: true, differences: [] }, { requestHashMatch: true }],
  ["调试唤醒请求", debugWakeRequestSchema, { reason: "manual", operationId: "op-k3j9x0a1b2c3" }, { reason: "manual" }],
  ["调试唤醒响应", debugWakeResponseSchema, { ok: true }, { ok: false }],
  ["run 规格", runSpecSchema, { variant: "memory-m1-structured-ledger", seed: "run-seed" }, { invalid: Number.NaN }],
  ["run 校验错误", runValidationErrorSchema, { code: "unknown-variant", message: "未知变体", path: "variant" }, { code: "", message: "x" }],
  ["run 创建请求", runCreateRequestSchema, { runSpec: { variant: "memory-m0-window" } }, { runSpec: [] }],
  ["run 创建响应", runCreateResponseSchema, { runId: "run-k3j9x0a1b2c3", status: "ready", errors: [] }, { runId: "run-k3j9x0a1b2c3", status: "queued", errors: [] }],
  ["run 摘要", runSummarySchema, runSummary, { ...runSummary, runId: "run-1" }],
  ["run 查询", runsQuerySchema, { status: "completed", limit: 20 }, { limit: 0 }],
  ["run 列表", runsResponseSchema, { runs: [runSummary] }, { runs: [{}] }],
  ["run 详情", runDetailResponseSchema, { runId: "run-k3j9x0a1b2c3", status: "completed", manifest: {}, manifestHash: "hash", contaminated: false, evidenceComplete: true }, { runId: "run-1", status: "completed", manifest: {}, manifestHash: "hash", contaminated: false, evidenceComplete: true }],
  ["run 状态变更请求", runStatusChangeRequestSchema, { operationId: "op-k3j9x0a1b2c3" }, {}],
  ["run 状态响应", runStatusResponseSchema, { runId: "run-k3j9x0a1b2c3", status: "running" }, { status: "running" }],
  ["有效性", runValiditySchema, report.validity, { valid: true }],
  ["报告指标", reportMetricSchema, report.metrics[0], { metric: "", numerator: 1, denominator: 1, value: 1 }],
  ["报告探针", reportProbeSchema, report.probes[0], { ...report.probes[0], score: { kind: "chat", correct: true } }],
  ["报告行为", reportBehaviorSchema, report.behavior[0], { ...report.behavior[0], atTick: -1 }],
  ["报告记忆", reportMemorySchema, report.memory, { recordsByTier: { short: -1 }, maintenanceRuns: 0, maintenanceFailures: 0 }],
  ["报告成本", reportCostSchema, report.cost, { ...report.cost, costEstimate: -1 }],
  ["报告延迟", reportLatencySchema, report.latency, { turnP50Ms: -1, turnP95Ms: null }],
  ["run 报告", runReportResponseSchema, report, { ...report, runId: "run-1" }],
  ["实验创建请求", experimentCreateRequestSchema, { experimentRef: "config/runs/exp-memory.yaml" }, { experimentRef: "" }],
  ["实验创建响应", experimentCreateResponseSchema, { experimentId: "exp-k3j9x0a1b2c3", runIds: ["run-k3j9x0a1b2c3"] }, { experimentId: "exp-1", runIds: [] }],
  ["实验指标摘要", experimentMetricSummarySchema, { metric: "recall-accuracy", validSamples: 3, invalidSamples: 0, mean: 0.5 }, { metric: "", validSamples: 3, invalidSamples: 0, mean: null }],
  ["实验分组摘要", experimentCellSummarySchema, { variant: "m1", scriptBranch: "break", runIds: ["run-k3j9x0a1b2c3"], metrics: [] }, { variant: "m1", scriptBranch: "break", runIds: ["run-1"], metrics: [] }],
  ["实验详情", experimentDetailResponseSchema, { experimentId: "exp-k3j9x0a1b2c3", runs: [runSummary], cells: [] }, { experimentId: "exp-1", runs: [], cells: [] }],
  ["导出请求", exportRequestSchema, { runId: "run-k3j9x0a1b2c3", redaction: "redacted", operationId: "op-k3j9x0a1b2c3" }, { runId: "run-k3j9x0a1b2c3", redaction: "full", operationId: "op-k3j9x0a1b2c3" }],
  ["导出响应", exportResponseSchema, { artifactId: "art-k3j9x0a1b2c3" }, { artifactId: "art-1" }],
];

describe("可观测、调试与评估接口 DTO", () => {
  it("trace 递归结构可解析多层 span", () => {
    const parsed = traceResponseSchema.safeParse(trace);
    expect(parsed.success).toBe(true);
  });

  it("每类请求与响应 DTO 都有合法与非法样例", () => {
    for (const [name, schema, valid, invalid] of dtoRows) {
      expect(schema.safeParse(valid).success, `${name} 应接受合法样例`).toBe(true);
      expect(schema.safeParse(invalid).success, `${name} 应拒绝非法样例`).toBe(false);
    }
  });
});
