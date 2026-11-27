/**
 * 核心职责：验证 turn 截止时把取消传给决策端口，并如实记录「端口未响应取消」。
 * 交互契约：真实宿主装配 + 自定义确定性决策端口；端口在收到信号后决定是否自行结束。
 * 截止由 turn 信号与等待截止的 sleep 两个计时器同时表达，终态不得随二者先后翻转。
 * 约束与禁忌：禁止真实等待整个 turn 超时；用极小的 maxTurnMs 逼近截止，并断言证据而非日志文案。
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serverModuleDefinitions, startHost, type HostOptions, type RunningHost } from "@world-prism/app-server";
import type { AuthContext, CommandType, Json, StorageRow } from "@world-prism/contracts";
import type { DeterministicDecisionInput, DeterministicDecisionPort } from "@world-prism/module-sdk";
import { gameCommandEnvelope } from "./game-support";

const target = "human-independent";
const roots: string[] = [];
const opened: RunningHost[] = [];
const releases: (() => void)[] = [];
let sequence = 0;

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  try {
    await Promise.all(opened.splice(0).map((host) => host.close()));
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), "world-prism-turn-cancel-"));
  roots.push(root);
  return root;
}

function cancelConfig(maxTurnMs: number): string {
  const directory = rootDir();
  const config = join(directory, "config");
  cpSync(resolve("config"), config, { recursive: true });
  cpSync(resolve("tests/fixtures/model"), join(directory, "tests", "fixtures", "model"), { recursive: true });
  writeFileSync(join(config, "turn-cancel-spec.yaml"), `
schemaVersion: 1
id: turn-cancel-spec
moduleAssemblyRef: local-slg-test-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: core-3
modelLayoutRef: deterministic-model-layout-v1
player: { principalId: player-1, factionId: null }
mode: live
initialState: { kind: cold-start }
variant: { id: turn-cancel-spec, profilePatchRefs: [decision-deterministic, turn-cancel-budget], agentIds: null }
script: null
clock: { kind: realtime }
budget: { maxTokens: null, maxCost: null }
failurePolicy: strict
`, "utf8");
  writeFileSync(join(config, "turn-cancel-budget.yaml"), `
schemaVersion: 1
profileId: turn-cancel-budget
kind: variant
parent: null
patch:
  budgets:
    maxModelCallsPerTurn: 6
    maxDecisionRounds: 4
    maxToolCallsPerTurn: 8
    maxToolCallsPerRound: 3
    maxTurnMs: ${maxTurnMs}
    maxReplans: 1
    maxTokensPerAgentPerDay: 60000
    reserveOutputTokens: { decision: 1500, speech: 400, memory-maintenance: 800 }
`, "utf8");
  return config;
}

/**
 * 可挂起的决策端口：记录是否收到取消信号，并在 `honour` 为真时随信号结束、否则一直挂起。
 * 返回的 `aborted` 用于断言宿主确实把取消传了下去。
 * `blockMs` 让端口在首次让出事件循环前同步占用一段时间：宿主在调用端口后才登记等待截止的 sleep，
 * 而 turn 信号的计时器在调用前已登记，因此该时长确定性地让信号先于 sleep 到期。
 */
function gatedDecision(honour: boolean, blockMs = 0) {
  const seen = { signal: null as AbortSignal | null, aborted: false };
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const start = new Promise<void>((resolveStart) => { entered = resolveStart; });
  releases.push(release);
  const definitions = serverModuleDefinitions.map((definition) => definition.id !== "agent.decision.deterministic"
    ? definition
    : {
      ...definition,
      create: async (input: Parameters<typeof definition.create>[0]) => {
        const instance = await definition.create(input);
        const base = instance.port as DeterministicDecisionPort;
        return {
          ...instance,
          port: {
            ...base,
            decide: async (turn: DeterministicDecisionInput) => {
              if (turn.session.agentId !== target) return base.decide(turn);
              seen.signal = turn.signal;
              const blockedUntil = performance.now() + blockMs;
              while (performance.now() < blockedUntil) {
                // 同步占用事件循环，模拟满载下 sleep 计时器晚于 turn 信号到期。
              }
              // 记录取消到达，而不是在端口阻塞期间到外部再读同一个信号。
              turn.signal.addEventListener("abort", () => { seen.aborted = true; }, { once: true });
              entered();
              if (honour) {
                await new Promise<void>((resolveAbort) => {
                  if (turn.signal.aborted) return resolveAbort();
                  turn.signal.addEventListener("abort", () => resolveAbort(), { once: true });
                });
                throw new Error("decision cancelled by turn deadline");
              }
              await gate;
              return base.decide(turn);
            },
          } satisfies DeterministicDecisionPort,
        };
      },
    });
  return { definitions, seen, entered: start, release };
}

function submit(host: RunningHost, type: CommandType, payload: Json): void {
  const auth: AuthContext = {
    principalId: "player-1", kind: "player", roles: ["player"], worldId: host.worldId,
    branchId: host.branchId, actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
  const receipt = host.authority.commands.execute(auth, gameCommandEnvelope(
    type, payload, `cmd-${String(++sequence).padStart(12, "0")}`,
  ));
  expect(receipt.commandStatus).toBe("accepted");
}

function clock(host: RunningHost): void {
  host.storage.transact((tx) => {
    const table = tx.branch(host.branchId).table("clock");
    const row = table.get({});
    if (row === null) throw new Error("Test world clock is missing");
    table.put({ ...row, mode: "running", world_tick: 0, run_version: Number(row["run_version"]) + 1 });
  });
}

async function startedHost(honour: boolean, blockMs = 0) {
  const gated = gatedDecision(honour, blockMs);
  const host = await startHost({
    dataDir: rootDir(), configRoot: cancelConfig(1_000), playerToken: "cancel-player",
    consoleToken: "cancel-console", assemblyRef: "local-slg-test-v1", rosterRef: "core-3",
    runSpecRef: "turn-cancel-spec", moduleDefinitions: gated.definitions,
  } satisfies HostOptions);
  opened.push(host);
  return { host, ...gated };
}

/** 读取目标 Agent 唯一 turn 的终态字段。 */
function targetTurn(host: RunningHost): StorageRow | undefined {
  return host.storage.transact((tx) => tx.rows("turn_runs").list({ branch_id: host.branchId, agent_id: target })[0]);
}

function turnStages(host: RunningHost): readonly { readonly stage: string; readonly reason: string | null }[] {
  const row: StorageRow | undefined = host.storage.transact((tx) =>
    tx.rows("turn_runs").list({ branch_id: host.branchId, agent_id: target })[0]);
  if (row === undefined) return [];
  return row["effective_json"] as { readonly stage: string; readonly reason: string | null }[];
}

describe("turn decision cancellation", () => {
  it("截止时把取消信号传给决策端口", async () => {
    const { host, seen, entered } = await startedHost(true);
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host);
    submit(host, "dialogue.say", { targetAgentId: target, text: "hello" });
    await entered;
    // 端口响应取消：宿主不应再把它当作仍在执行的任务。
    await expect.poll(() => seen.aborted, { timeout: 15_000, interval: 50 }).toBe(true);
    // 端口因响应取消而抛错，也只是「决策未在截止前完成」，终态按截止记录，不算执行失败。
    await expect.poll(() => targetTurn(host), { timeout: 20_000, interval: 100 })
      .toMatchObject({ status: "budget-exhausted", terminal_reason: "turn-deadline" });
  }, 40_000);

  it("端口不响应取消时记录 cancelled-not-honored", async () => {
    const { host, entered } = await startedHost(false);
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host);
    submit(host, "dialogue.say", { targetAgentId: target, text: "hello" });
    await entered;
    // 端口忽略信号并一直挂起：turn 必须按预算终止，并留下未响应取消的证据。
    await expect.poll(() => turnStages(host).find(({ stage }) => stage === "turn.decision-cancel")?.reason,
      { timeout: 20_000, interval: 100 }).toBe("cancelled-not-honored");
    // 端口忽略取消后仍挂起，宿主按预算放弃等待，该 turn 以截止终态收尾且原因可查。
    // 取消证据在放弃等待时单独提交，终态由随后的收尾事务写入，两者之间有时间差，因此终态同样轮询。
    await expect.poll(() => targetTurn(host), { timeout: 20_000, interval: 100 })
      .toMatchObject({ status: "budget-exhausted", terminal_reason: "turn-deadline" });
  }, 60_000);

  it("turn 信号先于等待截止的 sleep 到期时，终态仍按截止记录", async () => {
    // 端口同步占用 100ms 后才让出事件循环：sleep 的到期时间随之推后，turn 信号必然先中止 sleep。
    const { host, entered } = await startedHost(false, 100);
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host);
    submit(host, "dialogue.say", { targetAgentId: target, text: "hello" });
    await entered;
    await expect.poll(() => turnStages(host).find(({ stage }) => stage === "turn.decision-cancel")?.reason,
      { timeout: 20_000, interval: 100 }).toBe("cancelled-not-honored");
    await expect.poll(() => targetTurn(host), { timeout: 20_000, interval: 100 })
      .toMatchObject({ status: "budget-exhausted", terminal_reason: "turn-deadline" });
  }, 60_000);
});
