/**
 * 验证真实服务端通过已装配的 Agent 管线提交安全对白和动作。
 * 使用临时 SQLite、真实游戏规则与确定性策略，控制时钟和控制权的测试时序。
 * 不启动真实模型，不占用应用监听端口，不写入已有存档。
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverModuleDefinitions, startHost, type HostOptions, type RunningHost } from "@ai-npc/app-server";
import {
  conversationResponseSchema, decisionSubmissionSchema, type AuthContext, type CommandType, type Json, type StorageRow,
} from "@ai-npc/contracts";
import type { AgentDecisionPort, DeterministicDecisionInput } from "@ai-npc/module-sdk";
import { gameCommandEnvelope } from "./game-support";

const target = "human-independent";
const dirs: string[] = [];
const hosts: Promise<RunningHost>[] = [];
const releaseDecisions: (() => void)[] = [];

afterEach(async () => {
  for (const release of releaseDecisions.splice(0)) release();
  const opened = await Promise.allSettled(hosts.splice(0));
  const closed = await Promise.allSettled(opened.flatMap((entry) =>
    entry.status === "fulfilled" ? [entry.value.close()] : [],
  ));
  for (const result of closed) if (result.status === "rejected") throw result.reason;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-npc-turn-"));
  dirs.push(directory);
  return directory;
}

function hostWithAgents(overrides: Partial<HostOptions> = {}): Promise<RunningHost> {
  const host = startHost({
    dataDir: temporaryDirectory(), playerToken: "turn-player", consoleToken: "turn-console",
    assemblyRef: "local-slg-test-v1", rosterRef: "core-3",
    ...(overrides.configRoot === undefined ? deterministicConfig() : {}), ...overrides,
  });
  hosts.push(host);
  return host;
}

function player() {
  let sequence = 0;
  return (host: RunningHost, type: CommandType, payload: Json) => {
    const auth: AuthContext = {
      principalId: "player-1", kind: "player", roles: ["player"],
      worldId: host.worldId, branchId: host.branchId, actingAsAgentId: null,
      controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
    };
    const receipt = host.authority.commands.execute(auth, gameCommandEnvelope(
      type, payload, `cmd-${String(++sequence).padStart(12, "0")}`,
    ));
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ commandStatus: "accepted" });
    return receipt;
  };
}

function clock(host: RunningHost, worldTick: number, mode: "running" | "paused"): void {
  host.storage.transact((tx) => {
    const table = tx.branch(host.branchId).table("clock");
    const state = table.get({});
    if (state === null) throw new Error("Test world clock is missing");
    table.put({
      ...state, mode, world_tick: worldTick,
      run_version: Number(state["run_version"]) + (state["mode"] === mode ? 0 : 1),
    });
  });
}

function turns(host: RunningHost): readonly StorageRow[] {
  return host.storage.transact((tx) => tx.rows("turn_runs").list({ branch_id: host.branchId, agent_id: target }, {
    orderBy: [{ column: "agent_turn_index", direction: "asc" }],
  }));
}

function events(host: RunningHost, type: string, principalId?: string): readonly StorageRow[] {
  return host.storage.transact((tx) => tx.branch(host.branchId).table("domain_events").list({
    type, ...(principalId === undefined ? {} : { principal_id: principalId }),
  }, { orderBy: [{ column: "world_seq", direction: "asc" }] }));
}

async function terminalTurn(host: RunningHost, index: number): Promise<StorageRow> {
  return vi.waitFor(() => {
    const turn = turns(host)[index];
    expect(turn?.["ended_at"]).toEqual(expect.any(String));
    if (turn === undefined) throw new Error("Expected a persisted turn");
    return turn;
  }, { timeout: 8000, interval: 25 });
}

function readDecision(host: RunningHost, turn: StorageRow) {
  const stages = turn["effective_json"] as { stage: string; effective: { artifactId?: string } | null }[];
  const artifactId = stages.find(({ stage }) => stage === "turn.decision")?.effective?.artifactId;
  if (artifactId === undefined) throw new Error(`No decision artifact: ${JSON.stringify(turn)}`);
  const stored = host.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
  const body = stored?.["body"];
  if (!(body instanceof Uint8Array)) throw new Error("Decision artifact body is missing");
  return decisionSubmissionSchema.parse(JSON.parse(new TextDecoder().decode(body)).decision);
}

function holdFirstDecision(): { readonly definitions: NonNullable<HostOptions["moduleDefinitions"]>; readonly entered: Promise<void>; release(): void } {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolveEntered) => { enter = resolveEntered; });
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  releaseDecisions.push(release);
  let held = false;
  const definitions = serverModuleDefinitions.map((definition) => definition.id !== "agent.decision.deterministic"
    ? definition
    : {
      ...definition,
      create: async (input: Parameters<typeof definition.create>[0]) => {
        const instance = await definition.create(input);
        const base = instance.port as AgentDecisionPort<DeterministicDecisionInput>;
        const port: AgentDecisionPort<DeterministicDecisionInput> = {
          decide: async (turn) => {
            const result = await base.decide(turn);
            if (!held && turn.session.agentId === target && turn.triggers.some(({ kind }) => kind === "player-dialogue")) {
              held = true;
              enter();
              await gate;
            }
            return result;
          },
        };
        return { ...instance, port };
      },
    });
  return { definitions, entered, release };
}

function deterministicConfig(memory?: "none" | "ledger"): Pick<HostOptions, "configRoot" | "runSpecRef"> {
  const directory = temporaryDirectory();
  const root = join(directory, "config");
  cpSync(resolve("config"), root, { recursive: true });
  cpSync(resolve("tests/fixtures/model"), join(directory, "tests/fixtures/model"), { recursive: true });
  writeFileSync(join(root, "memory-comparison.yaml"), `
schemaVersion: 1
id: memory-comparison
moduleAssemblyRef: local-slg-test-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: core-3
modelLayoutRef: deterministic-model-layout-v1
player: { principalId: player-1, factionId: null }
mode: live
initialState: { kind: cold-start }
variant: { id: memory-comparison, profilePatchRefs: [${memory === undefined ? "" : "comparison-strategy, "}decision-deterministic], agentIds: null }
script: null
clock: { kind: realtime }
budget: { maxTokens: null, maxCost: null }
failurePolicy: strict
`, "utf8");
  if (memory !== undefined) writeFileSync(join(root, "comparison-strategy.yaml"), `
schemaVersion: 1
profileId: comparison-strategy
kind: variant
parent: null
patch:
  slots:
    memory: { module: agent.memory.${memory}, config: {} }
`, "utf8");
  return { configRoot: root, runSpecRef: "memory-comparison" };
}

describe("确定性 Agent turn", () => {
  it("玩家对白触发一个 turn，已提交模板从会话接口可见并附带阶段证据", async () => {
    const host = await hostWithAgents();
    const submit = player();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 0, "running");
    submit(host, "dialogue.say", { targetAgentId: target, text: "你好，岑雁。" });
    const turn = await terminalTurn(host, 0);
    expect(turn).toMatchObject({ status: "completed", turn_lease_epoch: 1, terminal_reason: null });
    expect(turns(host)).toHaveLength(1);
    const login = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "turn-player" } });
    expect(login.statusCode).toBe(200);
    const { sessionToken } = login.json() as { sessionToken: string };
    const conversation = await host.app.inject({
      method: "GET", url: `/api/v1/conversations/${target}`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(conversation.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(conversation.json()).lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerId: target, text: "我知道了。" }),
    ]));
    const spans = host.storage.transact((tx) => tx.rows("trace_spans").list({ turn_id: String(turn["turn_id"]) }));
    expect(spans.map((span) => span["name"])).toEqual(expect.arrayContaining([
      "turn.claim", "turn.readiness", "turn.perception", "turn.memory.retrieve", "turn.context", "turn.compression",
      "turn.decision", "turn.tool-view", "turn.speech", "turn.settle",
    ]));
    expect(host.storage.transact((tx) => tx.rows("model_attempts").list())).toHaveLength(0);
  });

  it("在途 turn 固定观察边界，后续消息进入下一轮且按原会话回复", async () => {
    const gate = holdFirstDecision();
    const host = await hostWithAgents({ moduleDefinitions: gate.definitions });
    const submit = player();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 0, "running");
    submit(host, "dialogue.say", { targetAgentId: target, text: "你好。" });
    await gate.entered;
    const firstFrontier = turns(host)[0]?.["input_frontier_json"];
    submit(host, "dialogue.say", { targetAgentId: target, text: "能帮忙护送吗？" });
    await vi.waitFor(() => {
      const outstanding = host.storage.transact((tx) => tx.branch(host.branchId).table("triggers")
        .list({ agent_id: target, kind: "player-dialogue" }).filter((row) => row["consumed_by_turn_id"] === null));
      expect(outstanding).toHaveLength(1);
    });
    expect(turns(host)).toHaveLength(1);
    expect(turns(host)[0]?.["input_frontier_json"]).toEqual(firstFrontier);
    gate.release();
    expect(await terminalTurn(host, 1)).toMatchObject({ status: "completed" });
    expect(events(host, "DialogueSubmitted", target).map((row) => row["payload_json"])).toEqual([
      expect.objectContaining({ text: "我知道了。" }),
      expect.objectContaining({ text: "可以，就这么办。" }),
    ]);
  });

  it("恢复待认领的 turn，并逐一回复调度前已有的独立会话", async () => {
    const host = await hostWithAgents();
    const submit = player();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 0, "running");
    const requests = ["你好。", "能帮忙护送吗？", "收到。"].map((text) =>
      submit(host, "dialogue.say", { targetAgentId: target, text }));
    clock(host, 0, "paused");
    const queuedId = "turn-000000000001";
    const first = await vi.waitFor(() => host.storage.transact((tx) => {
      const pending = tx.branch(host.branchId).table("triggers").list({ agent_id: target, kind: "player-dialogue" });
      expect(pending).toHaveLength(requests.length);
      const trigger = pending.find((row) => row["source_ref"] === requests[0]?.acceptedEventIds[0]);
      expect(trigger).toBeDefined();
      return trigger;
    }));
    if (first === undefined) throw new Error("First conversation trigger has not been persisted");
    host.storage.transact((tx) => {
      const branch = tx.branch(host.branchId);
      const lease = branch.table("controller_leases").get({ agent_id: target });
      const runId = tx.rows("branches").get({ branch_id: host.branchId })?.["run_id"];
      if (lease === null || typeof runId !== "string") throw new Error("Missing test Agent lease or run");
      tx.rows("turn_runs").put({
        turn_id: queuedId, branch_id: host.branchId, run_id: runId, agent_id: target,
        agent_turn_index: 1, status: "queued", trigger_ids_json: [String(first["trigger_id"])],
        input_frontier_json: null, memory_revision: null, profile_hash: "pending",
        controller_epoch: Number(lease["controller_epoch"]), turn_lease_epoch: 0, lease_expires_at: null,
        terminal_reason: null, effective_json: [], created_at: "2026-01-01T00:00:00.000Z", created_tick: 0,
        started_at: null, ended_at: null,
      });
      branch.table("triggers").put({ ...first, consumed_by_turn_id: queuedId });
    });
    clock(host, 0, "running");
    expect(await terminalTurn(host, 0)).toMatchObject({ turn_id: queuedId, status: "completed", turn_lease_epoch: 1 });
    expect(await terminalTurn(host, requests.length - 1)).toMatchObject({ status: "completed" });
    expect(events(host, "DialogueSubmitted", target).map((row) => row["payload_json"])).toEqual(
      requests.map((request) => expect.objectContaining({
        conversationId: (request.result as { readonly conversationId: string }).conversationId,
      })),
    );
  });

  it("决策返回前发生接管时不提交旧对白，并释放该轮触发", async () => {
    const gate = holdFirstDecision();
    const host = await hostWithAgents({ moduleDefinitions: gate.definitions });
    const submit = player();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 0, "running");
    submit(host, "dialogue.say", { targetAgentId: target, text: "你好。" });
    await gate.entered;
    host.storage.transact((tx) => {
      const leases = tx.branch(host.branchId).table("controller_leases");
      const prior = leases.get({ agent_id: target });
      if (prior === null) throw new Error("Missing test controller lease");
      leases.put({ ...prior, controller_kind: "human", controller_principal_id: "operator-1", controller_epoch: 2 });
    });
    gate.release();
    expect(await terminalTurn(host, 0)).toMatchObject({ status: "cancelled", terminal_reason: "stale-controller" });
    expect(events(host, "DialogueSubmitted", target)).toHaveLength(0);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("triggers")
      .list({ agent_id: target, kind: "player-dialogue" }))).toEqual([
      expect.objectContaining({ consumed_by_turn_id: null }),
    ]);
  });

  it("暂停后持久化新触发，继续前不创建普通 turn", async () => {
    const host = await hostWithAgents();
    const submit = player();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 0, "running");
    submit(host, "dialogue.say", { targetAgentId: target, text: "你好。" });
    clock(host, 0, "paused");
    await vi.waitFor(() => {
      expect(host.storage.transact((tx) => tx.branch(host.branchId).table("triggers")
        .list({ agent_id: target, kind: "player-dialogue" }).filter((row) => row["consumed_by_turn_id"] === null))).toHaveLength(1);
    });
    expect(turns(host)).toHaveLength(0);
    clock(host, 0, "running");
    expect(await terminalTurn(host, 0)).toMatchObject({ status: "completed" });
  });

  it("重开后关闭旧分支的在途 turn，新分支可以开局并回复玩家", async () => {
    const gate = holdFirstDecision();
    const host = await hostWithAgents({ moduleDefinitions: gate.definitions });
    const submit = player();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 0, "running");
    submit(host, "dialogue.say", { targetAgentId: target, text: "你好。" });
    await gate.entered;
    const oldBranch = host.branchId;
    const priorTurn = turns(host)[0]?.["turn_id"];
    const login = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "turn-player" } });
    expect(login.statusCode).toBe(200);
    const { sessionToken } = login.json<{ sessionToken: string }>();
    const reset = await host.app.inject({
      method: "POST", url: "/api/v1/campaign/reset", headers: { authorization: `Bearer ${sessionToken}` },
      payload: { operationId: "op-000000000008" },
    });
    expect(reset.statusCode).toBe(200);
    expect(host.branchId).not.toBe(oldBranch);
    gate.release();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 0, "running");
    submit(host, "dialogue.say", { targetAgentId: target, text: "重开后你好。" });
    expect(await terminalTurn(host, 0)).toMatchObject({ status: "completed" });
    expect(events(host, "DialogueSubmitted", target)).toHaveLength(1);
    const old = host.storage.transact((tx) => ({
      turn: tx.rows("turn_runs").get({ turn_id: String(priorTurn) }),
      replies: tx.branch(oldBranch).table("domain_events").count({ type: "DialogueSubmitted", principal_id: target }),
    }));
    expect(old).toMatchObject({ turn: { status: "cancelled" }, replies: 0 });
  });

  it.each([
    { label: "M0", memory: "none" as const, stance: "accept", reason: "none" },
    { label: "M1", memory: "ledger" as const, stance: "decline", reason: "past-breach" },
  ])("$label 在交付协议违约后按自身记忆裁决护送请求", async ({ memory, stance, reason }) => {
    const host = await hostWithAgents(deterministicConfig(memory));
    const submit = player();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host, 2, "running");
    const proposalReceipt = submit(host, "agreement.propose", {
      parties: ["player-1", target], terms: [{
        kind: "deliver", obligorId: "player-1", resource: "supply", amount: 8,
        fromStockpileId: "sp-commons", toStockpileId: "sp-rubble", byTick: 36,
      }],
    });
    expect(await terminalTurn(host, 0)).toMatchObject({ status: "completed" });
    expect(events(host, "AgreementActivated")).toHaveLength(1);
    if (memory === "ledger") {
      const agreement = proposalReceipt.result as { readonly agreementId: string };
      clock(host, 36, "running");
      const reminderTurn = await terminalTurn(host, 1);
      expect(reminderTurn).toMatchObject({ status: "completed" });
      expect(readDecision(host, reminderTurn)).toMatchObject({
        stance: "inform", dialogueIntent: { kind: "remind", subjectRef: agreement.agreementId },
      });
      expect(events(host, "MessageSent", target).map((event) => event["payload_json"])).toEqual([
        expect.objectContaining({ to: ["player-1"], intentKind: "remind", text: expect.stringContaining(agreement.agreementId) }),
      ]);
    }
    clock(host, 37, "running");
    host.authority.jobs.runDue(host.branchId, 37);
    host.authority.consumers.run(host.branchId);
    expect(events(host, "AgreementBreached")).toHaveLength(1);
    clock(host, 60, "running");
    const request = submit(host, "dialogue.say", { targetAgentId: target, text: "我需要你派人护送隘口那条路，能帮忙吗？" });
    const eventId = request.acceptedEventIds[0];
    if (eventId === undefined) throw new Error("Player request has no committed event");
    const answerTurn = await vi.waitFor(() => {
      const trigger = host.storage.transact((tx) => tx.branch(host.branchId).table("triggers")
        .list({ agent_id: target, kind: "player-dialogue", source_ref: eventId })[0]);
      const turn = turns(host).find((row) => row["turn_id"] === trigger?.["consumed_by_turn_id"]);
      expect(turn?.["ended_at"]).toEqual(expect.any(String));
      if (turn === undefined) throw new Error("Missing turn for player request");
      return turn;
    }, { timeout: 8000, interval: 25 });
    expect(answerTurn).toMatchObject({ status: "completed" });
    expect(readDecision(host, answerTurn)).toMatchObject({ stance, dialogueIntent: { reasonCode: reason } });
  });
});
