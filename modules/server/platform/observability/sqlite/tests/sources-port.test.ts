/**
 * 核心职责：证明观测模块的 Agent 列表、turn 摘要、记忆快照、调试队列、分支差异与调试唤醒只依赖数据源端口：
 *   换成进程内的数据源、存储端口不可访问时，响应仍按既有契约组装。
 * 交互契约：依赖进程内数据源端口与最小宿主服务；断言对外 DTO 的字段与语义。
 * 约束与禁忌：不打开 SQLite、不启动宿主；不断言 SQL 或表结构。
 */
import { describe, expect, it } from "vitest";
import type { HostServices } from "@world-prism/contracts";
import type { ObservedMemoryRecord, ObservedTurnRun } from "@world-prism/module-sdk";
import { ObservabilityPort } from "../src/plugin";
import { fakeSources, inaccessibleStorage } from "./fake-sources";

const branchId = "br-000000000001";
const worldId = "wld-000000000001";
const agentId = "human-independent";

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000001`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: () => Promise.resolve(),
  rng: () => () => 0.5,
  hash: () => Promise.resolve("hash"),
  hashText: () => Promise.resolve("hash"),
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  tracer: { span: (_name, _attrs, fn) => fn() },
};

function portWith(sources: ReturnType<typeof fakeSources>): ObservabilityPort {
  const port = new ObservabilityPort(inaccessibleStorage(), { timelineLimit: 200 }, host);
  port.bind(sources);
  return port;
}

function turnRun(turnId: string, overrides: Partial<ObservedTurnRun> = {}): ObservedTurnRun {
  return {
    turnId,
    runId: "run-000000000001",
    branchId,
    agentId,
    agentTurnIndex: 1,
    status: "completed",
    triggerIds: [],
    inputFrontier: null,
    memoryRevision: null,
    terminalReason: null,
    effective: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function memoryVersion(overrides: Partial<ObservedMemoryRecord>): ObservedMemoryRecord {
  return {
    memoryId: "mem-000000000001",
    rowVersion: 1,
    kind: "episodic",
    status: "active",
    epistemic: "verified-event",
    releasePolicyId: "policy-public",
    validFromTick: 0,
    validUntilTick: null,
    createdRevision: 1,
    retiredRevision: null,
    sourceObservationIds: ["obs-000000000001"],
    content: { summaryZh: "记录" },
    ...overrides,
  };
}

describe("观测模块只经数据源端口取数", () => {
  it("Agent 列表按名册种类、控制权、位置与感知水位组装，缺省值按既有语义解释", () => {
    const sources = fakeSources({
      latestWorldSeq: () => 12,
      agentStates: () => [
        {
          agentId: "human-independent",
          rosterKind: "strategic",
          activationStatus: "active",
          controllerKind: "human",
          latestTurnStatus: "deciding",
          scannedThroughSeq: 9,
          nodeId: null,
        },
        {
          agentId: "npc-wenzhao",
          rosterKind: "character",
          activationStatus: "dormant",
          controllerKind: null,
          latestTurnStatus: null,
          scannedThroughSeq: null,
          nodeId: "node-gate",
        },
        {
          agentId: "human-earth-alliance",
          rosterKind: "strategic",
          activationStatus: "active",
          controllerKind: "script",
          latestTurnStatus: "completed",
          scannedThroughSeq: 12,
          nodeId: "archive",
        },
      ],
    });

    expect(portWith(sources).agents(branchId)).toEqual({
      agents: [
        {
          agentId: "human-independent",
          kind: "strategic",
          active: true,
          controllerKind: "human",
          location: null,
          turnStatus: "deciding",
          watermarkLag: 3,
        },
        {
          agentId: "npc-wenzhao",
          kind: "character",
          active: false,
          controllerKind: "agent",
          location: "node-gate",
          turnStatus: "idle",
          watermarkLag: 12,
        },
        {
          // 实验执行器的脚本窗口如实呈现，不折算成 Agent 或真人。
          agentId: "human-earth-alliance",
          kind: "strategic",
          active: true,
          controllerKind: "script",
          location: "archive",
          turnStatus: "completed",
          watermarkLag: 0,
        },
      ],
    });
    // 最新序号与 Agent 状态来自同一次读取，滞后以同一快照为基准。
    expect(sources.reads()).toBe(1);
  });

  it("turn 摘要在一次读取内汇总触发、工具调用与用量，任一次用量未知时总量为未知", () => {
    const sources = fakeSources({
      turnRuns: (filter) => {
        expect(filter).toEqual({ branchId, limit: 200 });
        return [turnRun("turn-000000000002", { agentTurnIndex: 2 }), turnRun("turn-000000000001")];
      },
      turnModelUsages: (turnIds) => {
        expect(turnIds).toEqual(["turn-000000000002", "turn-000000000001"]);
        return new Map([
          ["turn-000000000002", [{ inputTokens: 5, outputTokens: 2 }, { inputTokens: 1, outputTokens: 1 }]],
          ["turn-000000000001", [{ inputTokens: 5, outputTokens: 2 }, null]],
        ]);
      },
      turnToolCallCounts: () => new Map([["turn-000000000002", 3]]),
      turnTriggerKinds: () => new Map([["turn-000000000001", ["debug", "patrol"]]]),
    });

    const { turns } = portWith(sources).turns({ branchId, limit: 500 });
    expect(turns.map(({ turnId, triggerKinds, modelCalls, toolCalls, tokens }) =>
      ({ turnId, triggerKinds, modelCalls, toolCalls, tokens }))).toEqual([
      { turnId: "turn-000000000002", triggerKinds: [], modelCalls: 2, toolCalls: 3, tokens: { input: 6, output: 3 } },
      {
        turnId: "turn-000000000001",
        triggerKinds: ["debug", "patrol"],
        modelCalls: 2,
        toolCalls: 0,
        tokens: { input: null, output: null },
      },
    ]);
    expect(sources.reads()).toBe(1);
  });

  it("记忆快照只返回目标 revision 可见的行版本，高于已提交水位的 revision 以 not-found 拒绝", () => {
    const sources = fakeSources({
      branchWorldId: () => worldId,
      memoryWatermark: () => ({ revision: 2, observationSeqConsumed: 0, derivedThroughTick: 0 }),
      memoryRecords: () => [
        memoryVersion({ rowVersion: 1, createdRevision: 1, retiredRevision: 2 }),
        memoryVersion({ rowVersion: 2, createdRevision: 2, sourceObservationIds: ["obs-000000000002"] }),
        memoryVersion({ memoryId: "mem-000000000002", createdRevision: 2 }),
      ],
    });
    const port = portWith(sources);

    expect(port.memory(branchId, agentId, 1).records.map(({ memoryId, revision }) => ({ memoryId, revision })))
      .toEqual([{ memoryId: "mem-000000000001", revision: 1 }]);
    expect(port.memoryDiff(branchId, agentId, 1, 2)).toEqual({
      added: [{ memoryId: "mem-000000000002", sourceObservationIds: ["obs-000000000001"] }],
      retired: [],
      changed: [{ memoryId: "mem-000000000001", sourceObservationIds: ["obs-000000000002"] }],
    });
    expect(() => port.memory(branchId, agentId, 3)).toThrow(expect.objectContaining({ code: "not-found" }));
  });

  it("调试队列按数据源给出的计数与创建时间汇总最早项", () => {
    const sources = fakeSources({
      schedulerQueue: () => ({ queued: 2, running: 1 }),
      startedModelAttemptTimes: () => ["2026-01-01T00:00:05.000Z", "2026-01-01T00:00:01.000Z"],
      pendingMaintenance: () => [
        { status: "leased", createdAt: "2026-01-01T00:00:03.000Z" },
        { status: "queued", createdAt: "2026-01-01T00:00:02.000Z" },
        { status: "queued", createdAt: "2026-01-01T00:00:04.000Z" },
      ],
    });

    expect(portWith(sources).debugQueues(branchId)).toEqual({
      scheduler: { queued: 2, running: 1, oldestAt: null },
      modelPool: { queued: null, running: 2, oldestAt: "2026-01-01T00:00:01.000Z" },
      maintenance: { queued: 2, running: 1, oldestAt: "2026-01-01T00:00:02.000Z" },
    });
  });

  it("分支差异按序号比较两侧事件，调试唤醒转交数据源登记", () => {
    const event = (worldSeq: number, value: string) => ({
      worldSeq,
      worldTick: 1,
      eventId: `evt-00000000000${String(worldSeq)}`,
      type: "WorldEvent",
      principalId: agentId,
      audience: { kind: "public" },
      payload: { value },
      correlationId: "cor-000000000001",
      committedAt: "2026-01-01T00:00:00.000Z",
    });
    const sources = fakeSources({
      domainEventsAfter: (branch) => branch === "br-left"
        ? [event(2, "same"), event(3, "left")]
        : [event(2, "same"), event(3, "right"), event(4, "right-only")],
    });
    const port = portWith(sources);

    expect(port.branchCompare("br-left", "br-right", 1).differences).toEqual([
      {
        kind: "event",
        key: "3",
        left: { type: "WorldEvent", payload: { value: "left" }, principalId: agentId },
        right: { type: "WorldEvent", payload: { value: "right" }, principalId: agentId },
      },
      { kind: "event", key: "4", left: null, right: { type: "WorldEvent", payload: { value: "right-only" }, principalId: agentId } },
    ]);
    const wake = { branchId, agentId, reason: "检查", operationId: "op-000000000001", principalId: "researcher" };
    expect(port.debugWake(wake)).toEqual({ ok: true });
    expect(sources.wakes).toEqual([wake]);
  });
});
