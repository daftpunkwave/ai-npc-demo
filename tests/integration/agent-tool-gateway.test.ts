/**
 * 核心职责：验证工具视图截断、binding 动态收窄、空 enum 省略、命令空字段清理与 operationId 幂等。
 * 交互契约：使用 kernel 小装配启动工具模块，并通过 agent-runtime ToolGateway 执行模型调用。
 * 约束与禁忌：不得绕过工具网关直接调用命令 executor，也不得重复派遣同一 operation。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DomainError, checkJsonBudget, jsonInputBudget, type CommandEnvelope, type CommandReceipt, type Json, type NormalizedToolCall, type ToolExecutionResult } from "@world-prism/contracts";
import {
  assertToolCallResultPairing,
  StoredAgentArtifactStore,
  ToolGateway,
  type AgentArtifactStore,
  type ToolGatewayTurn,
} from "@world-prism/agent-runtime";
import { toolsetDocumentSchema } from "@world-prism/mod-agent-tools-game-tools";
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

/** 按 JSON 输入预算的口径计节点数：标量与容器各计 1 个。 */
function jsonNodeCount(value: Json): number {
  if (value === null || typeof value !== "object") return 1;
  const children: readonly Json[] = Array.isArray(value) ? value : Object.values(value);
  return children.reduce<number>((total, child) => total + jsonNodeCount(child), 1);
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

  it("命令网关幂等冲突映射为工具 idempotency-conflict", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: () => {
        throw new DomainError("idempotency-conflict", "命令 ID 已被不同内容使用");
      },
    });
    const result = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-command-conflict",
      wireName: "asset_dispatch",
      arguments: dispatchArguments("team-allowed"),
      argumentsRaw: JSON.stringify(dispatchArguments("team-allowed")),
    });
    expect(result.result.executionStatus).toBe("error");
    expect(result.result.reasonCode).toBe("idempotency-conflict");
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

  it("把本次工具调用的 operationId 交给命令执行器，结果与 tool_calls 记录同一取值", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const submitted: string[] = [];
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope, operationId) => {
        submitted.push(operationId);
        return { ...receipt(harness.host, envelope), operationId };
      },
    });
    const args = dispatchArguments("team-allowed");
    const outcome = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-operation-id",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
      operationId: "op-00000000000e",
    });
    expect(submitted).toEqual(["op-00000000000e"]);
    expect(outcome.result.operationId).toBe("op-00000000000e");
    const row = harness.storage.transact((tx) => tx.rows("tool_calls").list({
      run_id: testRunId,
      turn_id: testTurnId,
      attempt_id: testAttemptId,
      provider_call_id: "provider-call-operation-id",
    })[0]);
    expect(row?.["operation_id"]).toBe("op-00000000000e");
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
  it("定向消息缺少授权上下文时拒绝派发，不执行消息提交", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    let sent = 0;
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: () => { throw new Error("Message transport must use the speech executor"); },
      executeMessage: () => { sent += 1; throw new Error("Unauthorized message must not be dispatched"); },
    });
    const args = { to: ["player-1"], intent: { kind: "acknowledge", tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] } };
    const call = { ...turn([]), wireName: "message_send", arguments: args, argumentsRaw: JSON.stringify(args) };
    const outcome = await gateway.executeCall({ ...call, providerCallId: "message-missing-audience" });
    expect(outcome.result).toMatchObject({ executionStatus: "error", commandStatus: null, reasonCode: "no-authority" });
    expect(sent).toBe(0);
  });
  it("定向消息回执已提交时复用原 operation，避免重复发送", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    let sent = 0;
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: () => { throw new Error("Message transport must use the speech executor"); },
      executeMessage: ({ commandId }) => {
        sent += 1;
        const stored = {
          ...receipt(harness.host, { commandId, type: "speech.commit", schemaVersion: 1, payload: {} }),
          result: { messageId: "msg-000000000001" },
        };
        harness.storage.transact((tx) => tx.branch(testBranchId).table("command_receipts").put({
          principal_id: testAgentId, command_id: commandId, command_type: "speech.commit",
          payload_hash: "speech-test-payload", receipt_json: stored, created_at: harness.host.nowIso(),
        }));
        throw new Error("Response lost after commit");
      },
    });
    const args = { to: ["player-1"], intent: { kind: "acknowledge", tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] } };
    const call = {
      ...turn([]), wireName: "message_send", arguments: args, argumentsRaw: JSON.stringify(args), operationId: "op-000000000003",
      narrowing: { teamIds: [], messagePrincipalIds: new Set(["player-1"]) },
    };
    const missed = await gateway.executeCall({ ...call, providerCallId: "message-unknown" });
    expect(missed.result.executionStatus).toBe("unknown");
    const recovered = await gateway.executeCall({ ...call, providerCallId: "message-recovered" });
    expect(recovered.result).toMatchObject({ commandStatus: "accepted", data: { messageId: "msg-000000000001" } });
    expect(sent).toBe(1);
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

  it("查询执行器收到的是剔除 null 可选字段后的参数", async () => {
    // 上层用「字段是否存在」区分「调用方没给」与「显式给 null」，因此 null 可选字段
    // 不能进入查询执行器；否则缺省与显式 null 会被压成同一种语义。
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    let received: Record<string, unknown> | null = null;
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      executeCommand: (_auth, envelope) => receipt(harness.host, envelope),
      executeQuery: ({ arguments: queryArguments }) => {
        received = queryArguments as Record<string, unknown>;
        return { ok: true };
      },
    });
    await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-null-fields",
      wireName: "world_inspect",
      arguments: { nodeId: null },
      argumentsRaw: "{}",
    });
    expect(received).not.toBeNull();
    expect(received).not.toHaveProperty("nodeId");
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
  it("参数超出 JSON 输入预算时按参数非法结算，不让 turn 崩溃", async () => {
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
    // 远超 JSON 深度预算的参数：模型可以产出，但不得让 canonicalJson 的 TypeError 打断 turn。
    let deep: Json = null;
    for (let index = 0; index < 5_000; index += 1) {
      deep = [deep];
    }
    const outcome = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-deep-args",
      wireName: "asset_dispatch",
      arguments: deep,
      argumentsRaw: JSON.stringify(deep),
    });
    expect(outcome.result).toMatchObject({ executionStatus: "error", reasonCode: "invalid-params" });
    expect(outcome.result.detail).toContain("JSON");
    expect(calls).toBe(0);
    // 拒绝被结算即可：调用方拿到可读原因，而不是异常。
    expect(outcome.isError).toBe(true);
  });

  it("超预算参数的重试沿用既有结算，不重复结算也不产生幂等冲突", async () => {
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
    let deep: Json = null;
    for (let index = 0; index < 5_000; index += 1) {
      deep = [deep];
    }
    const retryInput = {
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-deep-retry",
      wireName: "asset_dispatch",
      arguments: deep,
      argumentsRaw: "[]",
    };
    const first = await gateway.executeCall(retryInput);
    const second = await gateway.executeCall(retryInput);
    // 两次都返回同一条已结算结果：不是 idempotency-conflict，也没有第二条 tool_calls 行。
    expect(second.toolCallId).toBe(first.toolCallId);
    expect(second.result.reasonCode).toBe("invalid-params");
    const rows = harness.storage.transact((tx) => tx.rows("tool_calls").list({
      run_id: testRunId,
      turn_id: testTurnId,
      attempt_id: testAttemptId,
      provider_call_id: "provider-call-deep-retry",
    }));
    expect(rows).toHaveLength(1);
  });

  it("超预算参数不写入原始参数，artifact 只保留预算拒绝标记", async () => {
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
    let deep: Json = null;
    for (let index = 0; index < 5_000; index += 1) {
      deep = [deep];
    }
    const outcome = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-deep-artifact",
      wireName: "asset_dispatch",
      arguments: deep,
      argumentsRaw: "[]",
    });
    const stored = JSON.parse(JSON.stringify(outcome.rawArtifact.value)) as { readonly [key: string]: Json };
    // 原始参数无法规范化序列化，也不值得审计；artifact 只留可检索的拒绝标记。
    expect(stored["input"]).toEqual({ rejected: "json-input-budget" });
    expect(stored["argumentsRaw"]).toBe("");
    expect(outcome.rawArtifact.byteSize).toBeLessThan(4_096);
  });

  it.each([
    ["嵌套深度恰为上限", (): Json => {
      // 参数根对象占第 1 层，额外字段里再嵌套 maxDepth - 1 层数组，整体深度恰为上限。
      let deep: Json = null;
      for (let index = 0; index < jsonInputBudget.maxDepth - 1; index += 1) {
        deep = [deep];
      }
      return { ...(dispatchArguments("team-allowed") as Record<string, Json>), extra: deep };
    }],
    ["节点数恰为上限", (): Json => {
      // 参数根对象、各字段与额外数组本身都计节点；数组元素补足到整体恰好等于节点上限。
      const base = { ...(dispatchArguments("team-allowed") as Record<string, Json>), extra: [] as Json[] };
      const fill = jsonInputBudget.maxNodes - jsonNodeCount(base);
      return { ...base, extra: Array.from({ length: fill }, () => null) };
    }],
  ] as const)("参数%s时仍按参数非法结算并写入 artifact，不因外层结构二次超限", async (_label, argsOf) => {
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
    const args = argsOf();
    // 参数本身恰好在预算内：能算出参数摘要，进入正常的 schema 校验与结算路径。
    expect(checkJsonBudget(args)).toBeNull();
    const outcome = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: `provider-call-boundary-${_label}`,
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: "[]",
    });
    expect(outcome.result).toMatchObject({ executionStatus: "error", reasonCode: "invalid-params" });
    expect(calls).toBe(0);
    // 嵌进 artifact 外层后超出预算：参数改记拒绝标记，结算结果与 artifact 仍完整写入。
    const stored = JSON.parse(JSON.stringify(outcome.rawArtifact.value)) as { readonly [key: string]: Json };
    expect(stored["input"]).toEqual({ rejected: "json-input-budget" });
    expect(stored["argumentsRaw"]).toBe("");
    expect(stored["argsHash"]).toEqual(expect.any(String));
    const row = harness.storage.transact((tx) => tx.rows("tool_calls").get({ tool_call_id: outcome.toolCallId }));
    expect(row?.["status"]).toBe("settled");
    expect(row?.["raw_artifact_id"]).toBe(outcome.rawArtifact.artifactId);
  });

  it("已结算调用不会被后续超预算参数覆盖", async () => {
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
    const settled = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-settled-then-deep",
      wireName: "asset_dispatch",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
    });
    expect(settled.result.executionStatus).toBe("ok");

    let deep: Json = null;
    for (let index = 0; index < 5_000; index += 1) {
      deep = [deep];
    }
    const afterDeep = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-settled-then-deep",
      wireName: "asset_dispatch",
      arguments: deep,
      argumentsRaw: "[]",
    });
    // 首次结算保持权威：不会因为后续超预算参数被改写成 invalid-params。
    expect(afterDeep.toolCallId).toBe(settled.toolCallId);
    expect(afterDeep.result.executionStatus).toBe("ok");
    expect(afterDeep.result.reasonCode).toBeNull();
  });

  it("三份工具集均可解析且战略集不提供 task.respond", () => {
    expect(toolset("character-default").tools).toHaveLength(12);
    expect(toolset("character-broadcaster").tools.find((entry) => entry.toolId === "message.send")?.permissionProfile)
      .toBe("message-principals-or-public");
    const strategic = toolset("strategic-default");
    expect(strategic.tools.some((entry) => entry.toolId === "task.respond")).toBe(false);
    expect(strategic.tools.find((entry) => entry.toolId === "policy.set")?.permissionProfile).toBe("policy-owner");
  });
  it("循环引用的 artifact 值在遍历前被预算拒绝", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const stored = new StoredAgentArtifactStore(harness.storage, harness.host);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    // 循环引用必须在遍历前被拒绝：否则显式栈会无限增长直到耗尽内存。
    await expect(
      stored.put({ runId: null, kind: "tool-raw", value: cyclic as never }),
    ).rejects.toThrow(/JSON 预算/);
  });

  it("超预算参数重试换工具时返回幂等冲突而不是旧结果", async () => {
    const harness = await createAgentContextToolsHarness();
    harnesses.push(harness);
    const document = toolset("character-default");
    harness.tools.bindAgentToolset({ agentId: testAgentId, toolsetId: document.toolsetId, tools: document.tools });
    const gateway = new ToolGateway({
      storage: harness.storage,
      host: harness.host,
      tools: harness.tools,
      toolView: harness.toolView,
      artifacts: new StoredAgentArtifactStore(harness.storage, harness.host),
      executeCommand: (_auth, envelope) => receipt(harness.host, envelope),
    });
    // 第一次调用就提交超预算参数：进入 OVER_BUDGET_ARGS_HASH 分支并结算为 invalid-params。
    const deep = { nested: {} as Record<string, unknown> };
    let cursor = deep.nested;
    for (let index = 0; index < 260; index += 1) {
      cursor["next"] = {};
      cursor = cursor["next"] as Record<string, unknown>;
    }
    const first = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-budget-conflict",
      wireName: "asset_dispatch",
      arguments: deep as never,
      argumentsRaw: "{}",
    });
    expect(first.result.reasonCode).toBe("invalid-params");

    // 同一 provider call 换成另一个工具再重试：工具身份不匹配必须报幂等冲突，
    // 而不是把首次的超预算结算结果当作本次调用的结果返回。
    const args = dispatchArguments("team-allowed");
    const conflict = await gateway.executeCall({
      ...turn(["team-allowed"]),
      providerCallId: "provider-call-budget-conflict",
      wireName: "message_send",
      arguments: args,
      argumentsRaw: JSON.stringify(args),
    });
    expect(conflict.result.reasonCode).toBe("idempotency-conflict");
  });
});
