/**
 * 使用真实服务端测试装配验证模型决策、工具回传、对白提交与拒绝路径。
 * 夹具和 SQLite 写在独立测试目录，观察证据通过公开契约和持久档案读取。
 * 禁止发起真实模型请求、占用端口或修改开发存档。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAssembly, serverModuleDefinitions, startHost, type HostOptions, type RunningHost } from "@world-prism/app-server";
import { modelRequestSchema, type AuthContext, type Json, type StorageRow } from "@world-prism/contracts";
import { gameCommandEnvelope } from "./game-support";
import { standardModelTestKey, stubStandardModelHttp } from "./standard-model-support";

const target = "human-independent";
const roots: string[] = [];
const opened: RunningHost[] = [];

afterEach(async () => {
  try {
    await Promise.all(opened.splice(0).map((host) => host.close()));
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function rootDir() {
  const root = mkdtempSync(join(tmpdir(), "world-prism-model-turn-"));
  roots.push(root);
  return root;
}

function fixtureConfig(lines: readonly Json[], layoutTransform = (layout: string) => layout): string {
  const root = rootDir();
  const config = join(root, "config");
  cpSync("config", config, { recursive: true });
  const fixtures = join(root, "tests", "fixtures", "model");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, "default.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  const layout = join(config, "model-layouts", "deterministic-model-layout-v1.yaml");
  writeFileSync(layout, layoutTransform(readFileSync(layout, "utf8")), "utf8");
  return config;
}

async function modelHost(options: Partial<HostOptions> = {}) {
  const host = await startHost({
    dataDir: rootDir(), playerToken: "model-player", consoleToken: "model-console",
    ...(options.assembly === undefined ? { assemblyRef: "local-slg-test-v1" } : {}), rosterRef: "core-3", ...options,
  });
  opened.push(host);
  return host;
}

function runCampaign(host: RunningHost, tick = 0): AuthContext {
  const auth: AuthContext = {
    principalId: "player-1", kind: "player", roles: ["player"], worldId: host.worldId,
    branchId: host.branchId, actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
  const start = host.authority.commands.execute(auth, gameCommandEnvelope("campaign.start",
    { factionId: "human-neutral" }, "cmd-000000000001"));
  expect(start.commandStatus).toBe("accepted");
  host.storage.transact((tx) => {
    const clock = tx.branch(host.branchId).table("clock");
    const row = clock.get({});
    if (row === null) throw new Error("Test clock not initialized");
    clock.put({ ...row, mode: "running", world_tick: tick, run_version: Number(row["run_version"]) + 1 });
  });
  return auth;
}

function startConversation(host: RunningHost, text: string): string {
  const auth = runCampaign(host);
  const message = host.authority.commands.execute(auth, gameCommandEnvelope("dialogue.say",
    { targetAgentId: target, text }, "cmd-000000000002"));
  expect(message).toMatchObject({ commandStatus: "accepted", acceptedEventIds: [expect.any(String)] });
  return message.acceptedEventIds[0]!;
}

function attempts(host: RunningHost, turnId: string): readonly StorageRow[] {
  return host.storage.transact((tx) => tx.rows("model_attempts").list({ work_ref: turnId }));
}

function turnFor(host: RunningHost, eventId: string, terminal = true): Promise<StorageRow> {
  return vi.waitFor(() => {
    const turn = host.storage.transact((tx) => {
      const trigger = tx.branch(host.branchId).table("triggers").list({ source_ref: eventId, agent_id: target })[0];
      return typeof trigger?.["consumed_by_turn_id"] === "string"
        ? tx.rows("turn_runs").get({ turn_id: trigger["consumed_by_turn_id"] }) : null;
    });
    expect(turn).not.toBeNull();
    if (terminal) expect(turn?.["ended_at"]).toEqual(expect.any(String));
    return turn!;
  }, { timeout: 8_000, interval: 20 });
}

function artifact(host: RunningHost, artifactId: unknown): Json {
  const body = host.storage.transact((tx) =>
    tx.rows("artifacts").get({ artifact_id: String(artifactId) })?.["body"]);
  if (!(body instanceof Uint8Array)) throw new Error("Expected model artifact body");
  return JSON.parse(new TextDecoder().decode(body)) as Json;
}

function requests(host: RunningHost, turnId: string) {
  return attempts(host, turnId).map((attempt) => {
    const value = artifact(host, attempt["request_artifact_id"]) as { request: Json };
    return modelRequestSchema.parse(value.request);
  }).sort((left, right) => left.context.round - right.context.round);
}

function replies(host: RunningHost) {
  return host.storage.transact((tx) => tx.branch(host.branchId).table("domain_events")
    .list({ type: "DialogueSubmitted", principal_id: target }));
}

const submission = {
  stance: "inform", dialogueIntent: {
    kind: "acknowledge", audience: ["player-1"], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [],
  },
  noteworthy: [], citedMemoryIds: [], decisionNote: "只留在决策档案中的说明",
} satisfies Json;

function submitted(round: number, candidate: Json, delayMs = 0): Json {
  return {
    id: `decision-${round}`, match: { purpose: "decision", agentId: target, round },
    response: { finishReason: "tool_calls", delayMs, toolCalls: [{ name: "decision_submit", arguments: candidate }] },
  };
}

describe("确定性模型装配与角色对白", () => {
  it("完成没有发言主体的自主巡检，且不生成对白", async () => {
    const host = await modelHost();
    runCampaign(host, 8);
    const turn = await vi.waitFor(() => {
      const result = host.storage.transact((tx) => {
        const source = tx.branch(host.branchId).table("triggers").list({ agent_id: target, kind: "patrol" })[0];
        const turnId = source?.["consumed_by_turn_id"];
        return typeof turnId === "string" ? tx.rows("turn_runs").get({ turn_id: turnId }) : null;
      });
      expect(result?.["ended_at"]).toEqual(expect.any(String));
      return result;
    }, { timeout: 8_000, interval: 20 });
    expect(turn).toMatchObject({ status: "completed" });
    expect(requests(host, String(turn?.["turn_id"]))).toEqual([
      expect.objectContaining({ purpose: "decision", context: expect.objectContaining({ triggerPrincipalIds: [] }) }),
    ]);
    expect(replies(host)).toHaveLength(0);
  });

  it("经真实模型池执行查询并原样回放，再通过独立 speech 提交回复", async () => {
    const host = await modelHost();
    const turn = await turnFor(host, startConversation(host, "我想请你护送一趟。"));
    expect(turn).toMatchObject({ status: "completed" });
    const turnId = String(turn["turn_id"]);
    const all = requests(host, turnId);
    const decision = all.filter(({ purpose }) => purpose === "decision");
    expect(decision).toHaveLength(2);
    expect(decision[1]?.system).toBe(decision[0]?.system);
    expect(decision[1]?.tools).toEqual(decision[0]?.tools);
    expect(decision[1]?.messages).toEqual([
      decision[0]?.messages[0],
      expect.objectContaining({ role: "assistant", providerReplay: {
        content: [{ type: "tool_use", id: "fixture-1-1", name: "world_inspect", input: { nodeId: null } }],
      } }),
      expect.objectContaining({ role: "tool", toolCallId: "fixture-1-1", isError: false }),
    ]);
    expect(decision[1]?.context.contextArtifactId).not.toBe(decision[0]?.context.contextArtifactId);
    const speech = all.find(({ purpose }) => purpose === "speech");
    expect(speech).toMatchObject({ tools: [], output: { kind: "json", schemaName: "speech" },
      messages: [{ role: "user" }] });
    expect(JSON.stringify(speech)).not.toContain("world_inspect");
    expect(turn["effective_json"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "turn.speech", effective: expect.objectContaining({ source: "model", fallback: false }) }),
    ]));
    expect(replies(host)).toHaveLength(1);
    expect(replies(host)[0]?.["payload_json"]).toMatchObject({ text: "我知道了。" });
  });

  it("拒绝两次不存在的引用，只提醒一次且不提交对白", async () => {
    const bad = { ...submission as object, citedMemoryIds: ["mem-000000000099"] } as Json;
    const host = await modelHost({ configRoot: fixtureConfig([submitted(1, bad), submitted(2, bad)]) });
    const turn = await turnFor(host, startConversation(host, "记得那件事情吗？"));
    expect(turn).toMatchObject({ status: "failed", terminal_reason: "invalid-decision" });
    const all = requests(host, String(turn["turn_id"]));
    expect(all.map(({ purpose }) => purpose)).toEqual(["decision", "decision"]);
    expect(all[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true, content: expect.stringContaining("invalid_decision") });
    expect(replies(host)).toHaveLength(0);
  });

  it("定向消息工具与最终对白都拒绝名册外角色", async () => {
    const data = { ...submission, dialogueIntent: { ...submission.dialogueIntent, audience: ["npc-wenzhao"] } };
    const host = await modelHost({ configRoot: fixtureConfig([{
      id: "message-outside-roster", match: { purpose: "decision", agentId: target, round: 1 },
      response: { finishReason: "tool_calls", toolCalls: [{
        name: "message_send",
        arguments: {
          to: ["npc-wenzhao"],
          intent: { kind: "inform", tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
        },
      }] },
    }, submitted(2, data), submitted(3, data)]) });
    const turn = await turnFor(host, startConversation(host, "请转告闻昭。"));
    expect(turn).toMatchObject({ status: "failed", terminal_reason: "invalid-decision" });
    const all = requests(host, String(turn["turn_id"]));
    expect(all.map(({ purpose }) => purpose)).toEqual(["decision", "decision", "decision"]);
    expect(all[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true, content: expect.stringContaining("no-authority") });
    expect(all[2]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true, content: expect.stringContaining("invalid_decision") });
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("domain_events")
      .list({ type: "MessageSent", principal_id: target }))).toHaveLength(0);
  });

  it("length 响应中的工具调用不执行", async () => {
    const host = await modelHost({ configRoot: fixtureConfig([{
      id: "truncated", match: { purpose: "decision", agentId: target },
      response: { finishReason: "length", toolCalls: [{ name: "world_inspect", arguments: { nodeId: null } }] },
    }]) });
    const turn = await turnFor(host, startConversation(host, "请调查。"));
    expect(turn).toMatchObject({ status: "failed", terminal_reason: "invalid-decision" });
    expect(attempts(host, String(turn["turn_id"]))).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(host.storage.transact((tx) => tx.rows("tool_calls").list({ turn_id: String(turn["turn_id"]) }))).toHaveLength(0);
    expect(replies(host)).toHaveLength(0);
  });

  it("工具预算触发预算停止后，收尾轮提交的决定仍被接受", async () => {
    const configRoot = fixtureConfig([
      { id: "inspect", match: { purpose: "decision", agentId: target, round: 1 },
        response: { finishReason: "tool_calls", toolCalls: [{ name: "world_inspect", arguments: { nodeId: null } }] } },
      { id: "blocked", match: { purpose: "decision", agentId: target, round: 2 },
        response: { finishReason: "tool_calls", toolCalls: [
          { name: "world_inspect", arguments: { nodeId: null } },
          { name: "decision_submit", arguments: { ...submission as object, citedMemoryIds: ["mem-000000000099"] } },
        ] } },
      submitted(3, submission),
      { id: "speech", match: { purpose: "speech", agentId: target },
        response: { finishReason: "stop", json: { utterance: "好的。", citedRefs: [] } } },
    ]);
    writeFileSync(join(configRoot, "profiles", "platform-baseline.yaml"),
      readFileSync(join(configRoot, "profiles", "platform-baseline.yaml"), "utf8")
        .replace("maxToolCallsPerTurn: 8", "maxToolCallsPerTurn: 1")
        .replace("maxToolCallsPerRound: 3", "maxToolCallsPerRound: 1"), "utf8");
    const host = await modelHost({ configRoot });
    const turn = await turnFor(host, startConversation(host, "请调查。"));
    expect(turn).toMatchObject({ status: "completed" });
    const turnId = String(turn["turn_id"]);
    const all = requests(host, turnId);
    const decisions = all.filter(({ purpose }) => purpose === "decision");
    expect(decisions).toHaveLength(3);
    expect(all.some(({ purpose }) => purpose === "speech")).toBe(true);
    const wrap = decisions[2]?.messages.filter(({ role }) => role === "tool") ?? [];
    expect(wrap).toHaveLength(3);
    expect(wrap[0]).toMatchObject({ role: "tool", isError: false });
    expect(wrap[1]).toMatchObject({ role: "tool", isError: true,
      content: expect.stringContaining("budget-exhausted") });
    expect(wrap[1]).toMatchObject({ content: expect.stringContaining("已达到本轮的调用上限") });
    expect(wrap[2]).toMatchObject({ role: "tool", isError: true,
      content: expect.stringContaining("invalid_decision") });
    const toolRows = host.storage.transact((tx) => tx.rows("tool_calls").list({ turn_id: turnId }));
    expect(toolRows).toHaveLength(1);
    const toolAttemptId = String(toolRows[0]?.["attempt_id"]);
    expect(toolAttemptId).toMatch(/^att-/);
    const modelAttemptIds = attempts(host, turnId).map((row) => String(row["attempt_id"]));
    expect(modelAttemptIds.length).toBeGreaterThanOrEqual(3);
    expect(modelAttemptIds.every((id) => id !== toolAttemptId)).toBe(true);
    expect(replies(host)).toHaveLength(1);
  });

  it("预算停止后的收尾轮仍未提交决定时按 over-budget 结束", async () => {
    const configRoot = fixtureConfig([
      { id: "inspect", match: { purpose: "decision", agentId: target, round: 1 },
        response: { finishReason: "tool_calls", toolCalls: [{ name: "world_inspect", arguments: { nodeId: null } }] } },
      { id: "blocked", match: { purpose: "decision", agentId: target, round: 2 },
        response: { finishReason: "tool_calls", toolCalls: [
          { name: "world_inspect", arguments: { nodeId: null } },
          { name: "decision_submit", arguments: { ...submission as object, citedMemoryIds: ["mem-000000000099"] } },
        ] } },
      { id: "no-submit", match: { purpose: "decision", agentId: target, round: 3 },
        response: { finishReason: "stop", text: "没有需要执行的动作。" } },
    ]);
    writeFileSync(join(configRoot, "profiles", "platform-baseline.yaml"),
      readFileSync(join(configRoot, "profiles", "platform-baseline.yaml"), "utf8")
        .replace("maxToolCallsPerTurn: 8", "maxToolCallsPerTurn: 1")
        .replace("maxToolCallsPerRound: 3", "maxToolCallsPerRound: 1"), "utf8");
    const host = await modelHost({ configRoot });
    const turn = await turnFor(host, startConversation(host, "请调查。"));
    // status 记录失败类别（over-budget 归为 failed）；决策循环一旦进入预算停止收尾，
    // terminal_reason 直接取 over-budget，不再被轮内细分原因（call-budget/context-window）覆盖。
    expect(turn).toMatchObject({ status: "failed", terminal_reason: "over-budget" });
    const all = requests(host, String(turn["turn_id"]));
    expect(all.map(({ purpose }) => purpose)).toEqual(["decision", "decision", "decision"]);
    expect(replies(host)).toHaveLength(0);
  });

  it("重复的 decision_submit 只接受首个并回传 duplicate 错误键", async () => {
    const bad = { ...submission as object, citedMemoryIds: ["mem-000000000099"] } as Json;
    const host = await modelHost({ configRoot: fixtureConfig([
      { id: "duplicated", match: { purpose: "decision", agentId: target, round: 1 },
        response: { finishReason: "tool_calls", toolCalls: [
          { name: "decision_submit", arguments: bad },
          { name: "decision_submit", arguments: bad },
        ] } },
      submitted(2, submission),
      { id: "speech", match: { purpose: "speech", agentId: target },
        response: { finishReason: "stop", json: { utterance: "好的。", citedRefs: [] } } },
    ]) });
    const turn = await turnFor(host, startConversation(host, "请回应。"));
    expect(turn).toMatchObject({ status: "completed" });
    const all = requests(host, String(turn["turn_id"]));
    const decisions = all.filter(({ purpose }) => purpose === "decision");
    expect(decisions).toHaveLength(2);
    expect(all.some(({ purpose }) => purpose === "speech")).toBe(true);
    const wrap = decisions[1]?.messages.filter(({ role }) => role === "tool") ?? [];
    expect(wrap).toHaveLength(2);
    expect(wrap[0]).toMatchObject({ role: "tool", isError: true,
      content: expect.stringContaining("invalid_decision") });
    expect(wrap[1]).toMatchObject({ role: "tool", isError: true,
      content: expect.stringContaining("duplicate_decision_submit") });
    expect(replies(host)).toHaveLength(1);
  });

  it("工具消息已提交相同意图时跳过最终对白且不重复发送", async () => {
    const intent = { kind: "inform", tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] };
    const host = await modelHost({ configRoot: fixtureConfig([
      { id: "send-message", match: { purpose: "decision", agentId: target, round: 1 },
        response: { finishReason: "tool_calls", toolCalls: [{
          name: "message_send", arguments: { to: ["player-1"], intent },
        }] } },
      submitted(2, { stance: "inform", dialogueIntent: { ...intent, audience: ["player-1"] },
        noteworthy: [], citedMemoryIds: [], decisionNote: "" } as Json),
      { id: "speech", match: { purpose: "speech", agentId: target },
        response: { finishReason: "stop", json: { utterance: "给你发过消息了。", citedRefs: [] } } },
    ]) });
    const turn = await turnFor(host, startConversation(host, "请给我发一条消息。"));
    expect(turn).toMatchObject({ status: "completed" });
    const turnId = String(turn["turn_id"]);
    expect(requests(host, turnId).filter(({ purpose }) => purpose === "speech")).toHaveLength(1);
    expect(turn["effective_json"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "turn.speech", status: "skipped", reason: "message-already-committed" }),
    ]));
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("domain_events")
      .list({ type: "MessageSent", principal_id: target }))).toHaveLength(1);
    expect(replies(host)).toHaveLength(0);
    // 工具消息经真实命令网关提交：回执记录的 operationId 与该工具调用的 operation 一致。
    const messageCall = host.storage.transact((tx) => tx.rows("tool_calls").list({ turn_id: turnId }))
      .find((row) => row["tool_id"] === "message.send");
    expect(messageCall?.["operation_id"]).toEqual(expect.stringMatching(/^op-/));
    const stored = host.storage.transact((tx) => tx.branch(host.branchId).table("command_receipts").get({
      principal_id: target,
      command_id: String(messageCall?.["command_id"]),
    }));
    expect((stored?.["receipt_json"] as { readonly operationId?: unknown } | undefined)?.operationId)
      .toBe(messageCall?.["operation_id"]);
  });

  it("对白只带受众可见资料，引用校验两次失败后使用安全模板", async () => {
    const host = await modelHost({ configRoot: fixtureConfig([submitted(1, submission), {
      id: "speech-invalid-reference", match: { purpose: "speech", agentId: target },
      response: { finishReason: "stop", json: { utterance: "不应提交这条对白。", citedRefs: ["ev-unknown"] } },
    }]) });
    const turn = await turnFor(host, startConversation(host, "请简要回应。"));
    expect(turn).toMatchObject({ status: "completed" });
    const speech = requests(host, String(turn["turn_id"])).filter(({ purpose }) => purpose === "speech");
    expect(speech).toHaveLength(2);
    for (const request of speech) {
      expect(request.messages).toEqual([{ role: "user", content: expect.stringContaining("请简要回应。") }]);
      expect(JSON.stringify(request)).not.toContain("只留在决策档案中的说明");
    }
    expect(turn["effective_json"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "turn.speech", reason: "speech-fallback" }),
    ]));
    expect(replies(host).map((row) => row["payload_json"])).toEqual([
      expect.objectContaining({ text: "我知道了。" }),
    ]);
  });

  it("接管后仅归档在途模型响应，不提交对白", async () => {
    const host = await modelHost({ configRoot: fixtureConfig([submitted(1, submission, 1_000)]) });
    const event = startConversation(host, "请回应。");
    const turn = await turnFor(host, event, false);
    const turnId = String(turn["turn_id"]);
    await vi.waitFor(() => expect(attempts(host, turnId)).toEqual([expect.objectContaining({ status: "started" })]));
    host.storage.transact((tx) => {
      const leases = tx.branch(host.branchId).table("controller_leases");
      const prior = leases.get({ agent_id: target });
      if (prior === null) throw new Error("Missing test controller lease");
      leases.put({ ...prior, controller_kind: "human", controller_principal_id: "operator-1", controller_epoch: 2 });
    });
    await vi.waitFor(() => expect(attempts(host, turnId)).toEqual([
      expect.objectContaining({ status: "superseded", is_effective: 0, response_artifact_id: expect.any(String) }),
    ]), { timeout: 5_000 });
    expect(replies(host)).toHaveLength(0);
  });

  it("对白在途发生接管时保留取消语义，不落被 fencing 拒绝的 fallback 对白", async () => {
    const host = await modelHost({ configRoot: fixtureConfig([submitted(1, submission), {
      id: "speech-delayed", match: { purpose: "speech", agentId: target },
      response: { finishReason: "stop", json: { utterance: "不应提交这条对白。", citedRefs: [] }, delayMs: 1_000 },
    }]) });
    const event = startConversation(host, "请回应。");
    const turn = await turnFor(host, event, false);
    const turnId = String(turn["turn_id"]);
    await vi.waitFor(() => expect(attempts(host, turnId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "speech", status: "started" }),
    ])));
    host.storage.transact((tx) => {
      const leases = tx.branch(host.branchId).table("controller_leases");
      const prior = leases.get({ agent_id: target });
      if (prior === null) throw new Error("Missing test controller lease");
      leases.put({ ...prior, controller_kind: "human", controller_principal_id: "operator-1", controller_epoch: 2 });
    });
    // 取消会释放触发消费状态，改为按 turnId 等待终态。
    const terminal = await vi.waitFor(() => {
      const row = host.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: turnId }));
      if (row === null || typeof row["ended_at"] !== "string") throw new Error("Turn has not ended yet");
      return row;
    }, { timeout: 8_000, interval: 20 });
    expect(terminal).toMatchObject({ status: "cancelled", terminal_reason: "stale-controller" });
    await vi.waitFor(() => expect(attempts(host, turnId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "speech", status: "superseded", is_effective: 0 }),
    ])), { timeout: 5_000 });
    // 取消的对白阶段直接中止：不生成 safe-template fallback artifact，也没有生成失败记录。
    const speechArtifacts = host.storage.transact((tx) =>
      tx.rows("artifacts").list({ run_id: turn["run_id"] as string }).filter((row) => row["kind"] === "speech"));
    expect(speechArtifacts).toHaveLength(0);
    expect(replies(host)).toHaveLength(0);
  });

  it("每轮都调用工具但轮次耗尽仍无有效提交时，以 round-limit 原因结束", async () => {
    const inspect = (round: number) => ({
      id: `inspect-${round}`, match: { purpose: "decision", agentId: target, round },
      response: {
        finishReason: "tool_calls",
        toolCalls: [{ name: "world_inspect", arguments: { nodeId: null } }],
      },
    });
    const host = await modelHost({ configRoot: fixtureConfig([inspect(1), inspect(2), inspect(3), inspect(4)]) });
    const turn = await turnFor(host, startConversation(host, "请持续调查。"));
    expect(turn).toMatchObject({ status: "budget-exhausted", terminal_reason: "round-limit" });
    expect(replies(host)).toHaveLength(0);
  });

  it("不可重试的传输失败以 model-failed 类别结束并回退到失败类别", async () => {
    const host = await modelHost({ configRoot: fixtureConfig([{
      id: "protocol-failure", match: { purpose: "decision", agentId: target },
      response: { error: { kind: "protocol", retryAfterMs: null } },
    }]) });
    const turn = await turnFor(host, startConversation(host, "请回应。"));
    expect(turn).toMatchObject({ status: "failed", terminal_reason: "model-failed" });
    expect(attempts(host, String(turn["turn_id"]))).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(replies(host)).toHaveLength(0);
  });

  it("接管发生在已提交的工具动作之后时保留原触发的消费位置", async () => {
    const host = await modelHost({ configRoot: fixtureConfig([{
      id: "send-a-message", match: { purpose: "decision", agentId: target, round: 1 },
      response: { finishReason: "tool_calls", toolCalls: [{
        name: "message_send",
        arguments: {
          to: ["player-1"],
          intent: { kind: "inform", tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [] },
        },
      }] },
    }, submitted(2, submission, 1_000)]) });
    const event = startConversation(host, "请给我发一条消息。");
    const turn = await turnFor(host, event, false);
    const turnId = String(turn["turn_id"]);
    await vi.waitFor(() => expect(attempts(host, turnId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "decision", status: "started" }),
      expect.objectContaining({ purpose: "speech", status: "succeeded" }),
    ])));
    host.storage.transact((tx) => {
      const branch = tx.branch(host.branchId);
      const messages = branch.table("domain_events").list({ type: "MessageSent", principal_id: target });
      expect(messages).toHaveLength(1);
      const leases = branch.table("controller_leases");
      const prior = leases.get({ agent_id: target });
      if (prior === null) throw new Error("Missing test controller lease");
      leases.put({ ...prior, controller_kind: "human", controller_principal_id: "operator-1", controller_epoch: 2 });
    });
    expect(await turnFor(host, event)).toMatchObject({ status: "failed", terminal_reason: "interrupted-after-command" });
    expect(replies(host)).toHaveLength(0);
  });

  it.each([false, true])("保持已部署的确定性运行的冻结清单（旧目录包含模型池：%s）", async (poolInCatalog) => {
    const configRoot = fixtureConfig([]);
    const baseline = join(configRoot, "profiles", "platform-baseline.yaml");
    if (poolInCatalog) {
      const runSpec = join(configRoot, "runs", "online-default.yaml");
      writeFileSync(runSpec, readFileSync(runSpec, "utf8").replace("variant: null",
        "variant: { id: decision-deterministic, profilePatchRefs: [decision-deterministic], agentIds: null }"), "utf8");
    } else {
      writeFileSync(baseline, readFileSync(baseline, "utf8").replace("agent.decision.model", "agent.decision.deterministic"), "utf8");
    }
    const liveTransports = ["platform.model-transport.openai-compatible", "platform.model-transport.anthropic"];
    const poolModules = ["agent.decision.model", "agent.model-pool.shared", "platform.budget.standard", "platform.model-transport.deterministic"];
    const standard = loadAssembly("local-slg-standard-v1");
    const { bindings, agentSlots } = standard.realms.server;
    const assembly = { ...standard, realms: { ...standard.realms, server: {
      bindings: bindings.filter(({ moduleId }) => ![...liveTransports, ...poolModules].includes(moduleId))
        .map((binding) => binding.capability === "platform.secrets" ? { ...binding, configRef: null } : binding),
      agentSlots: { ...agentSlots, decision: ["agent.decision.deterministic"] },
    },
    // 模型挂载页晚于模型池引入，远程依赖 agent.model-pool；模型池之前的装配不会绑定它。
    console: { bindings: standard.realms.console.bindings.filter(({ capability }) => capability !== "console.model-mounts") },
    } };
    const excluded = poolInCatalog ? liveTransports : [...liveTransports, ...poolModules];
    const dataDir = rootDir();
    const old = await modelHost({
      dataDir, configRoot, assembly,
      moduleDefinitions: serverModuleDefinitions.filter(({ id }) => !excluded.includes(id)),
    });
    const frozen = (host: RunningHost) => host.storage.transact((tx) => tx.rows("runs")
      .list({ branch_id: host.branchId })[0]);
    const expected = frozen(old);
    expect(expected?.["manifest_hash"]).toEqual(expect.any(String));
    await old.close();
    opened.splice(opened.indexOf(old), 1);
    const resumed = await modelHost({ dataDir, assemblyRef: "local-slg-standard-v1" });
    expect(resumed.branchId).toBe(old.branchId);
    const actual = frozen(resumed);
    expect(actual).toMatchObject({
      manifest_hash: expected?.["manifest_hash"], manifest_json: expected?.["manifest_json"],
      run_spec_json: expected?.["run_spec_json"],
    });
  });

  it("使用原价目摘要重启此前已冻结的夹具模型运行", async () => {
    const dataDir = rootDir();
    const before = await modelHost({ dataDir, moduleDefinitions: serverModuleDefinitions.filter(({ id }) =>
      id !== "platform.model-transport.openai-compatible" && id !== "platform.model-transport.anthropic") });
    const frozen = (host: RunningHost) => host.storage.transact((tx) => tx.rows("runs").list({ branch_id: host.branchId })[0]);
    const expected = frozen(before);
    expect(expected?.["manifest_json"]).toMatchObject({ models: { pricingVersion: "2026-11" } });
    await before.close();
    opened.splice(opened.indexOf(before), 1);
    const resumed = await modelHost({ dataDir });
    expect(frozen(resumed)).toMatchObject({ manifest_hash: expected?.["manifest_hash"], manifest_json: expected?.["manifest_json"] });
  });

  it("标准装配使用兼容传输完成玩家对白，凭据只存在于 HTTP 头", async () => {
    const restoreFetch = stubStandardModelHttp();
    try {
      const host = await modelHost({ assemblyRef: "local-slg-standard-v1" });
      runCampaign(host);
      const record = await turnFor(host, startConversation(host, "请留意水闸的状态。"));
      expect(record).toMatchObject({ status: "completed" });
      const turnId = String(record["turn_id"]);
      const rows = attempts(host, turnId);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ purpose: "decision", adapter_id: "platform.model-transport.openai-compatible", status: "succeeded" }),
        expect.objectContaining({ purpose: "speech", adapter_id: "platform.model-transport.openai-compatible", status: "succeeded" }),
      ]));
      expect(replies(host)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "DialogueSubmitted" })]));
      const wires = rows.map((row) => artifact(host, row["request_artifact_id"]));
      expect(JSON.stringify(wires)).toContain("json_object");
      expect(JSON.stringify(wires)).not.toContain(standardModelTestKey);
    } finally {
      restoreFetch();
    }
  });

  it("网关布局按部署变量关闭推理，上游返回名命中别名时不记为模型替换", async () => {
    const requested = "deepseek-v4.1-flash-official";
    const served = "deepseek/deepseek-flash";
    const restoreFetch = stubStandardModelHttp({ requested, served });
    try {
      vi.stubEnv("WORLD_PRISM_OPENAI_COMPAT_THINKING", "disabled");
      vi.stubEnv("WORLD_PRISM_OPENAI_COMPAT_SERVED_MODELS", served);
      const host = await modelHost({ assemblyRef: "local-slg-standard-v1", modelLayoutRef: "openai-compatible-gateway-layout-v1" });
      runCampaign(host);
      const record = await turnFor(host, startConversation(host, "请留意水闸的状态。"));
      expect(record).toMatchObject({ status: "completed" });
      const turnId = String(record["turn_id"]);
      const rows = attempts(host, turnId);
      expect(rows.map((row) => [row["purpose"], row["status"]]).sort())
        .toEqual([["decision", "succeeded"], ["speech", "succeeded"]]);
      for (const row of rows) {
        expect(artifact(host, row["request_artifact_id"])).toMatchObject({
          servedModels: [served], request: { externalModel: requested },
          wire: { model: requested, thinking: { type: "disabled" }, temperature: 0.6 },
        });
        expect(artifact(host, row["response_artifact_id"])).toMatchObject({ response: { servedModel: served } });
      }
      const effective = host.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: turnId })?.["effective_json"]);
      const modelStages = (typeof effective === "string" ? JSON.parse(effective) as Json[] : effective as Json[])
        .filter((entry) => (entry as { stage?: string }).stage === "turn.model");
      expect(modelStages).toHaveLength(2);
      for (const stage of modelStages) {
        expect(stage).toMatchObject({ status: "applied", reason: null, effective: { attempts: [{ servedModel: served, substituted: false }] } });
      }
    } finally {
      restoreFetch();
    }
  });

  it("预检拒绝模型与价目记录指向不同的供应商模型", async () => {
    const restoreFetch = stubStandardModelHttp();
    try {
      vi.stubEnv("WORLD_PRISM_OPENAI_COMPAT_MODEL", "unpriced-model");
      await expect(modelHost({ assemblyRef: "local-slg-standard-v1" })).rejects.toThrow(
        "externalModel 与价目记录不一致",
      );
    } finally {
      restoreFetch();
    }
  });

  it("确定性决策沿用空上下文配置完成对白且不发起模型调用", async () => {
    const configRoot = fixtureConfig([]);
    writeFileSync(join(configRoot, "deterministic-simplified-context.yaml"), `
schemaVersion: 1
id: deterministic-simplified-context
moduleAssemblyRef: local-slg-test-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: core-3
modelLayoutRef: deterministic-model-layout-v1
player: { principalId: player-1, factionId: null }
mode: live
initialState: { kind: cold-start }
variant: { id: deterministic-simplified-context, profilePatchRefs: [simplified-context, decision-deterministic], agentIds: null }
script: null
clock: { kind: realtime }
budget: { maxTokens: null, maxCost: null }
failurePolicy: strict
`, "utf8");
    writeFileSync(join(configRoot, "simplified-context.yaml"), `
schemaVersion: 1
profileId: simplified-context
kind: variant
parent: null
patch:
  slots:
    context: { module: agent.context.ordered-blocks, config: {} }
`, "utf8");
    const host = await modelHost({ configRoot, runSpecRef: "deterministic-simplified-context" });
    const turn = await turnFor(host, startConversation(host, "请简要回应。"));
    expect(turn).toMatchObject({ status: "completed" });
    expect(attempts(host, String(turn["turn_id"]))).toHaveLength(0);
    expect(replies(host).map((row) => row["payload_json"])).toEqual([
      expect.objectContaining({ text: "我知道了。" }),
    ]);
  });

  it.each([
    { name: "缺少 decision 预算的战略 profile", drop: "decision" },
    { name: "缺少 speech 预算的战略 profile", drop: "speech" },
  ])("预检拒绝$name", async ({ drop }) => {
    const configRoot = fixtureConfig([]);
    const strategic = join(configRoot, "profiles", "agent-strategic-default.yaml");
    writeFileSync(strategic, readFileSync(strategic, "utf8")
      .replace(new RegExp(`^ {6}${drop}: \\{.*\\n`, "mu"), ""), "utf8");
    await expect(modelHost({ configRoot })).rejects.toThrow(
      `agent-strategic-default」的上下文配置缺少 ${drop} 预算块`);
  });

  it.each([
    { name: "重复挂载", purposes: "[decision, decision, speech]", error: "重复挂载" },
    { name: "缺少对白用途", purposes: "[decision]", error: "speech 挂载" },
    { name: "缺少决策用途", purposes: "[speech]", error: "decision 挂载" },
  ])("预检拒绝$name", async ({ purposes, error }) => {
    const configRoot = fixtureConfig([], (layout) => layout.replace("[decision, speech, memory-maintenance]", purposes));
    await expect(modelHost({ configRoot })).rejects.toThrow(error);
  });

  it("预检拒绝放不下必需上下文及工具 schema 的模型窗口", async () => {
    const configRoot = fixtureConfig([], (layout) => layout.replace("contextWindowTokens: 64000", "contextWindowTokens: 4500"));
    await expect(modelHost({ configRoot })).rejects.toThrow("模型窗口无法容纳必需上下文和工具预算");
  });

  it("预检拒绝预留超过挂载用途上限，并指出主体、用途与两个数值", async () => {
    // 把 decision 用途上限压到 1500 以下，使 profile 的 1500 预留超限：
    // 这条诊断必须能直接定位到是哪个主体、哪个用途、预留与上限各是多少。
    const configRoot = fixtureConfig([], (layout) =>
      layout.replace("maxOutputTokensByPurpose: { decision: 1500, speech: 400, memory-maintenance: 800 }",
        "maxOutputTokensByPurpose: { decision: 1200, speech: 400, memory-maintenance: 800 }"));
    await expect(modelHost({ configRoot })).rejects.toThrow(
      /human-independent 的 decision 输出预留 1500 超过挂载 npc-fixture 的用途上限 1200/u);
  });

  it("预检拒绝放不下对白输出预留的独立挂载窗口", async () => {
    const configRoot = fixtureConfig([], (layout) => {
      const agentIds = layout.match(/agentIds: \[([^\]]+)\]/)?.[1];
      if (agentIds === undefined) throw new Error("Test layout missing mount agentIds");
      return layout
        .replace("models:", `models:
  npc-fixture-speech-tiny:
    connectionId: fixtures
    externalModel: deterministic-v1
    parameters: {}
    capabilities: { toolCalling: true, strictTools: true, structuredOutput: json_schema, assistantReplay: verbatim, contextWindowTokens: 500, maxOutputTokens: 400, embedding: true, embeddingDimensions: 64 }
    limits: { maxConcurrent: 2, requestsPerMinute: 240, tokensPerMinute: 1000000, requestTimeoutMs: 10000 }
    maxOutputTokensByPurpose: { speech: 400 }`)
        .replace("purposes: [decision, speech, memory-maintenance]", `purposes: [decision, memory-maintenance]
  - modelId: npc-fixture-speech-tiny
    agentIds: [${agentIds}]
    purposes: [speech]`);
    });
    const pricing = join(configRoot, "pricing.yaml");
    writeFileSync(pricing, readFileSync(pricing, "utf8")
      .replace("models:", "models:\n  npc-fixture-speech-tiny: { externalModel: deterministic-v1, inputPerMTok: 0, outputPerMTok: 0 }"), "utf8");
    await expect(modelHost({ configRoot })).rejects.toThrow("模型窗口无法容纳必需上下文和工具预算");
  });
});
