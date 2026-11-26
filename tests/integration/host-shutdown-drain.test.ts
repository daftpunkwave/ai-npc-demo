/**
 * 核心职责：验证生产关闭路径先排空再释放，且卡住的 turn 不会让关闭无限挂起。
 * 交互契约：使用真实 SQLite 与宿主装配；用自定义决策模块把 turn 卡在决策阶段。
 * 约束与禁忌：禁止启动真实监听端口，也不依赖真实计时器长等待；关闭预算由宿主选项显式给出。
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverModuleDefinitions, startHost, type HostOptions, type RunningHost } from "@world-prism/app-server";
import type { AuthContext, CommandType, Json, StorageRow } from "@world-prism/contracts";
import type { AgentDecisionPort, DeterministicDecisionInput } from "@world-prism/module-sdk";
import { gameCommandEnvelope } from "./game-support";

const target = "human-independent";
const roots: string[] = [];
const opened: RunningHost[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  try {
    await Promise.all(opened.splice(0).map((host) => host.close()));
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), "world-prism-shutdown-"));
  roots.push(root);
  return root;
}

/** 与确定性装配相同的配置根，但决策由用例注入的模块提供。 */
function shutdownConfig(): string {
  const directory = rootDir();
  const config = join(directory, "config");
  cpSync(resolve("config"), config, { recursive: true });
  cpSync(resolve("tests/fixtures/model"), join(directory, "tests", "fixtures", "model"), { recursive: true });
  writeFileSync(join(config, "shutdown-spec.yaml"), `
schemaVersion: 1
id: shutdown-spec
moduleAssemblyRef: local-slg-test-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: core-3
modelLayoutRef: deterministic-model-layout-v1
player: { principalId: player-1, factionId: null }
mode: live
initialState: { kind: cold-start }
variant: { id: shutdown-spec, profilePatchRefs: [decision-deterministic], agentIds: null }
script: null
clock: { kind: realtime }
budget: { maxTokens: null, maxCost: null }
failurePolicy: strict
`, "utf8");
  return config;
}

/** 把确定性决策替换为可挂起的替身：进入后一直等待释放，用于模拟卡住的 turn。 */
function gatedDecision(): { readonly definitions: NonNullable<HostOptions["moduleDefinitions"]>; readonly entered: Promise<void>; release(): void } {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolveEntered) => { enter = resolveEntered; });
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  releases.push(release);
  let held = false;
  const definitions = serverModuleDefinitions.map((definition) => definition.id !== "agent.decision.deterministic"
    ? definition
    : {
      ...definition,
      create: async (input: Parameters<typeof definition.create>[0]) => {
        const instance = await definition.create(input);
        const base = instance.port as AgentDecisionPort<DeterministicDecisionInput>;
        return {
          ...instance,
          port: {
            ...base,
            decide: async (turn: DeterministicDecisionInput) => {
              // 只挂起真正要产生对白的 turn，避免影响开局等无关流程。
              if (!held && turn.session.agentId === target) {
                held = true;
                enter();
                await gate;
              }
              return base.decide(turn);
            },
          } satisfies AgentDecisionPort<DeterministicDecisionInput>,
        };
      },
    });
  return { definitions, entered, release };
}

async function gatedHost(): Promise<{ readonly host: RunningHost; readonly entered: Promise<void> }> {
  const gate = gatedDecision();
  const host = await startHost({
    dataDir: rootDir(), configRoot: shutdownConfig(), playerToken: "shutdown-player",
    consoleToken: "shutdown-console", assemblyRef: "local-slg-test-v1", rosterRef: "core-3",
    runSpecRef: "shutdown-spec", moduleDefinitions: gate.definitions,
    shutdownDrainMs: 200,
  } satisfies HostOptions);
  opened.push(host);
  return { host, entered: gate.entered };
}

let sequence = 0;

function submit(host: RunningHost, type: CommandType, payload: Json): void {
  const auth: AuthContext = {
    principalId: "player-1", kind: "player", roles: ["player"], worldId: host.worldId,
    branchId: host.branchId, actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
  const commandId = `cmd-${String(++sequence).padStart(12, "0")}`;
  const receipt = host.authority.commands.execute(auth, gameCommandEnvelope(type, payload, commandId));
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

function turns(host: RunningHost): readonly StorageRow[] {
  return host.storage.transact((tx) => tx.rows("turn_runs").list({ branch_id: host.branchId, agent_id: target }));
}

describe("host shutdown drain", () => {
  it("卡住的 turn 不会让关闭无限挂起，排空后仍释放存储", async () => {
    const { host, entered } = await gatedHost();
    submit(host, "campaign.start", { factionId: "human-neutral" });
    clock(host);
    submit(host, "dialogue.say", { targetAgentId: target, text: "hello" });
    await entered;
    const startedAt = Date.now();
    await host.close();
    // 排空预算为 200 毫秒：关闭必须在预算量级内返回，而不是等挂起的决策结束。
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    // 释放阶段照常执行，存储句柄已关闭。
    expect(() => turns(host)).toThrow();
  }, 40_000);
});
