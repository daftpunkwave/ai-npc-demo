/**
 * 核心职责：验证工具视图截断、binding 动态收窄、空 enum 省略、命令空字段清理与 operationId 幂等。
 * 交互契约：使用 kernel 小装配启动工具模块，并通过 agent-runtime ToolGateway 执行模型调用。
 * 约束与禁忌：不得绕过工具网关直接调用命令 executor，也不得重复派遣同一 operation。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { CommandEnvelope, CommandReceipt, Json, NormalizedToolCall, ToolExecutionResult } from "@ai-npc/contracts";
import {
  assertToolCallResultPairing,
  StoredAgentArtifactStore,
  ToolGateway,
  type AgentArtifactStore,
  type ToolGatewayTurn,
} from "@ai-npc/agent-runtime";
import { toolsetDocumentSchema } from "@ai-npc/mod-agent-tools-game-tools";
import {
  createAgentContextToolsHarness,
  testAgentId,
  testAttemptId,
  testBranchId,
  testRunId,
  testTurnId,
  testWorldId,
  testAuth,
  type AgentContextToolsHarness,
} from "./agent-context-tools-support";

const harnesses: AgentContextToolsHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function toolset(ref: "character-default" | "character-broadcaster" | "strategic-default") {
  const parsed = parse(readFileSync(`config/toolsets/${ref}.yaml`, "utf8")) as unknown;
  return toolsetDocumentSchema.parse(parsed);
}

function dispatchArguments(teamId: string): Json {
  return {
    taskType: "escort",
    teamId,
    invitees: [],
    fromStockpileId: null,
    toStockpileId: null,
    cargo: null,
    roadId: "r-wg-gate",
    durationTicks: null,
    groupId: null,
    toNodeId: null,
    medicalStockpileId: null,
    energyStockpileId: null,
    supplyStockpileId: null,
    nodeId: null,
    departAfterTicks: null,
  } as Json;
}

function turn(teamIds: readonly string[]): ToolGatewayTurn {
  return {
    session: { worldId: testWorldId, branchId: testBranchId, agentId: testAgentId },
    runId: testRunId,
    turnId: testTurnId,
    attemptId: testAttemptId,
    agentId: testAgentId,
    round: 1,
    phase: "decision",
    audience: ["player-1"],
    auth: testAuth(),
    narrowing: { teamIds },
  };
}

function receipt(host: AgentContextToolsHarness["host"], envelope: CommandEnvelope): CommandReceipt {
  return {
    receiptId: host.ids("rcp"),
    commandId: envelope.commandId,
    commandStatus: "accepted",
    reasonCode: null,
    safeMessage: null,
    acceptedEventIds: [],
    operationId: null,
    resultingVersions: {},
    result: { taskId: "task-000000000001", taskStatus: "pending", departTick: 21 },
    worldTick: 20,
  };
}

describe("Tool view and gateway", () => {
  it("结构化视图保留 envelope 并截断列表", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const result: ToolExecutionResult = {
      executionStatus: "ok",
      commandStatus: "accepted",
      taskStatus: "pending",
      reasonCode: null,
      receiptId: "rcp-000000000001",
      operationId: "op-000000000001",
      resultRef: "art-000000000001",
      detail: "accepted",
      data: { asOfTick: 20, roads: Array.from({ length: 8 }, (_, index) => ({ id: `road-${index}` })), secret: "hidden" },
    };
    const view = harness.toolView.render({
      phase: "decision",
      audience: ["player-1"],
      result,
      viewFields: ["asOfTick", "roads"],
      maxListItems: 3,
      maxTokens: 500,
    });
    const parsed = JSON.parse(view.text) as { readonly [key: string]: Json };
    expect(parsed["executionStatus"]).toBe("ok");
    expect(parsed["commandStatus"]).toBe("accepted");
    expect(parsed["taskStatus"]).toBe("pending");
    expect(parsed["resultRef"]).toBe("art-000000000001");
    expect((parsed["data"] as unknown as { readonly roads: readonly Json[] }).roads).toHaveLength(3);
    expect(parsed["omittedCount"]).toBe(5);
    expect(parsed["omittedFields"]).toContain("secret");
  });

  it("team enum 为空时省略 asset.dispatch", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => receipt(harness.host, envelope),
    });
    const projection = gateway.projectTools(turn([]));
    expect(projection.tools.some((tool) => tool.name === "asset_dispatch")).toBe(false);
    expect(projection.omissions).toContainEqual({ toolId: "asset.dispatch", reason: "empty-enum", field: "teamId" });
  });

  it("缺失动态授权集合时失败关闭并省略工具", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    let calls = 0;
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => {
        calls += 1;
        return receipt(harness.host, envelope);
      },
    });
    const bareTurn = { ...turn(["team-unused"]), narrowing: {} };
    const projection = gateway.projectTools(bareTurn);
    expect(projection.tools.some((tool) => tool.name === "asset_dispatch")).toBe(false);
    expect(projection.omissions).toContainEqual({
      toolId: "asset.dispatch",
      reason: "missing-authorization",
      field: "teamId",
    });
    const args = dispatchArguments("team-unused");
    const outcome = await gateway.executeCall({
      ...bareTurn,
      providerCallId: "provider-call-missing-auth",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
    });
    expect(outcome.result.reasonCode).toBe("no-authority");
    expect(calls).toBe(0);
  });
  it("越权 team 参数不发送命令", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    let calls = 0;
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => {
        calls += 1;
        return receipt(harness.host, envelope);
      },
    });
    const result = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-1",
      wireName: "asset_dispatch",
      arguments: dispatchArguments("team-other"),
      argumentsRaw: JSON.stringify(dispatchArguments("team-other")),
    });
    expect(calls).toBe(0);
    expect(result.result.executionStatus).toBe("error");
    expect(result.result.reasonCode).toBe("no-authority");
  });

  it("已结算调用参数冲突时保留原结果记录", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    let calls = 0;
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => {
        calls += 1;
        return receipt(harness.host, envelope);
      },
    });
    const args = dispatchArguments("team-allowed");
    const first = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-conflict",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
    });
    const conflict = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-conflict",
      wireName: "asset_dispatch",
      arguments: dispatchArguments("team-other"),
      argumentsRaw: JSON.stringify(dispatchArguments("team-other")),
    });
    expect(conflict.result.reasonCode).toBe("idempotency-conflict");
    expect(calls).toBe(1);
    expect(harness.storage.transact((tx) => tx.rows("artifacts").get({
      artifact_id: first.rawArtifact.artifactId,
    }))).not.toBeNull();
    expect(harness.storage.transact((tx) => tx.rows("tool_calls").get({
      tool_call_id: first.toolCallId,
    }))).toMatchObject({
      status: "settled",
      raw_artifact_id: first.rawArtifact.artifactId,
      execution_status: "ok",
    });
  });
  it("删除 null 字段并用同一 operationId 返回原结果", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const envelopes: CommandEnvelope[] = [];
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => {
        envelopes.push(envelope);
        return receipt(harness.host, envelope);
      },
    });
    const args = dispatchArguments("team-allowed");
    const first = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-1",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
      operationId: "op-000000000001",
    });
    const second = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-2",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
      operationId: "op-000000000001",
    });
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.payload).toEqual({
      taskType: "escort",
      teamId: "team-allowed",
      invitees: [],
      params: { roadId: "r-wg-gate" },
    });
    expect(first.result.resultRef).toBe(second.result.resultRef);
    expect(first.rawArtifact.kind).toBe("tool-raw");
    expect(first.viewArtifact.kind).toBe("tool-view");
    expect(second.toolCallId).not.toBe(first.toolCallId);
  });

  it("未知执行结果重试时复用 commandId 并重新核验", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const envelopes: CommandEnvelope[] = [];
    let calls = 0;
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => {
        calls += 1;
        envelopes.push(envelope);
        if (calls === 1) throw new Error("timeout after submit");
        return receipt(harness.host, envelope);
      },
    });
    const args = dispatchArguments("team-allowed");
    const first = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-unknown",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
      operationId: "op-000000000002",
    });
    expect(first.result.executionStatus).toBe("unknown");
    const second = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-recovered",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
      operationId: "op-000000000002",
    });
    expect(second.result.executionStatus).toBe("ok");
    expect(calls).toBe(2);
    expect(envelopes[0]?.commandId).toBe(envelopes[1]?.commandId);
  });
  it("artifact 持久化异步失败时结算为 unknown", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const stored = new StoredAgentArtifactStore(harness.storage, harness.host);
    let failNextPut = true;
    const artifacts: AgentArtifactStore = {
      get: (artifactId) => stored.get(artifactId),
      put: async (input) => {
        if (failNextPut) {
          failNextPut = false;
          throw new Error("artifact write failed");
        }
        return stored.put(input);
      },
    };
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      artifacts,
      executeCommand: (_auth, envelope) => receipt(harness.host, envelope),
    });
    const args = dispatchArguments("team-allowed");
    const outcome = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-persist-failure",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
    });
    expect(outcome.result.executionStatus).toBe("unknown");
    expect(outcome.result.reasonCode).toBe("execution-unknown");
  });
  it("同一响应批次为每个 call 生成同 callId 的结果", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => receipt(harness.host, envelope),
      executeQuery: ({ toolId }) => ({ toolId }),
    });
    const calls: readonly NormalizedToolCall[] = [
      { id: "provider-call-a", name: "world_inspect", arguments: { nodeId: null }, argumentsRaw: "{}", parseError: null },
      { id: "provider-call-b", name: "task_inspect", arguments: { taskId: null }, argumentsRaw: "{}", parseError: null },
    ];
    const outcomes = await gateway.executeCalls(turn(["team-allowed"]), calls);
    expect(outcomes.map((outcome) => outcome.providerCallId)).toEqual(["provider-call-a", "provider-call-b"]);
    expect(gateway.resultMessages(outcomes).filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["provider-call-a", "provider-call-b"]);
  });

  it("重复、缺失和多余 callId 的配对会失败", () => {
    const call: NormalizedToolCall = {
      id: "provider-call-a",
      name: "world_inspect",
      arguments: { nodeId: null },
      argumentsRaw: "{}",
      parseError: null,
    };
    expect(() => assertToolCallResultPairing([call, call], [])).toThrow("duplicate");
    expect(() => assertToolCallResultPairing([call], [])).toThrow("no result");
    expect(() => assertToolCallResultPairing([], [{
      providerCallId: "provider-call-extra",
      modelText: "{}",
      isError: false,
    }])).toThrow("no matching call");
  });
  it("已结算调用引用缺失 artifact 时拒绝复用", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => receipt(harness.host, envelope),
    });
    const args = dispatchArguments("team-allowed");
    const first = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-missing-artifact",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
    });
    harness.storage.transact((tx) => tx.rows("artifacts").delete({ artifact_id: first.rawArtifact.artifactId }));
    await expect(gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-missing-artifact",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
    })).rejects.toThrow("artifact");
  });
  it("三份工具集均可解析且战略集不提供 task.respond", () => {
    expect(toolset("character-default").tools).toHaveLength(12);
    expect(toolset("character-broadcaster").tools.find((entry) => entry.toolId === "message.send")?.permissionProfile)
      .toBe("message-principals-or-public");
    const strategic = toolset("strategic-default");
    expect(strategic.tools.some((entry) => entry.toolId === "task.respond")).toBe(false);
    expect(strategic.tools.find((entry) => entry.toolId === "policy.set")?.permissionProfile).toBe("policy-owner");
  });
});