/**
 * 使用真实服务端测试装配验证模型决策、工具回传、对白提交与拒绝路径。
 * 夹具和 SQLite 写在独立测试目录，观察证据通过公开契约和持久档案读取。
 * 禁止发起真实模型请求、占用端口或修改开发存档。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAssembly, serverModuleDefinitions, startHost, type HostOptions, type RunningHost } from "@ai-npc/app-server";
import { modelRequestSchema, type AuthContext, type Json, type StorageRow } from "@ai-npc/contracts";
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
  const root = mkdtempSync(join(tmpdir(), "ai-npc-model-turn-"));
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
      expect(row?.["ended_at"]).toEqual(expect.any(String));
      return row!;
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
    } } };
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

  it("预检拒绝模型与价目记录指向不同的供应商模型", async () => {
    const restoreFetch = stubStandardModelHttp();
    try {
      vi.stubEnv("NPC_OPENAI_COMPAT_MODEL", "unpriced-model");
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
