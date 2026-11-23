/**
 * 核心职责：验证四个记忆主组在同一输入下的入模记忆段确实不同，以及 M3 核心块位置与 M0 current 的会话窗口。
 * 交互契约：使用真实测试装配、SQLite、确定性模型传输与内容包；
 * 入模内容取自 turn 的 context artifact，而不是模块内部状态。
 * 约束与禁忌：禁止用比较模块内部状态代替比较实际入模文本；四组必须走同一命令脚本与同一 tick。
 * 走模型决策路径是必需的：确定性决策跳过 context 阶段，不产生 context artifact。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHost, type HostOptions, type RunningHost } from "@ai-npc/app-server";
import type { AuthContext, Json } from "@ai-npc/contracts";
import { gameCommandEnvelope } from "./game-support";

const target = "human-independent";
const dirs: string[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  const closed = await Promise.allSettled(hosts.splice(0).map((host) => host.close()));
  for (const result of closed) if (result.status === "rejected") throw result.reason;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-npc-memory-variants-"));
  dirs.push(directory);
  return directory;
}

/** 一份只包含「回答」的决策 fixture：模型路径下不需要工具调用即可结束 turn。 */
const answerFixture = JSON.stringify({
  id: "variant-answer",
  match: { purpose: "decision" },
  response: {
    finishReason: "tool_calls",
    toolCalls: [{
      name: "decision_submit",
      arguments: {
        stance: "inform",
        dialogueIntent: {
          kind: "acknowledge", audience: ["player-1"], tone: "neutral",
          reasonCode: "none", subjectRef: null, factRefs: [],
        },
        noteworthy: [], citedMemoryIds: [], decisionNote: "记忆组对比用例",
      },
    }],
  },
});

/**
 * 复制仓库配置，写入使用指定记忆 variant 的 RunSpec 与单条决策 fixture。
 * variant 的 profilePatchRefs 同时含该记忆组补丁与 model-decision，
 * 使 context 阶段真实执行并产出 artifact；其余槽位与测试装配一致。
 */
function variantConfig(variantRef: string, layoutTransform: (text: string) => string = (text) => text): string {
  const directory = temporaryDirectory();
  const root = join(directory, "config");
  cpSync(resolve("config"), root, { recursive: true });
  const fixtures = join(directory, "tests", "fixtures", "model");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, "default.jsonl"), `${answerFixture}\n`, "utf8");
  const layout = join(root, "model-layouts", "deterministic-model-layout-v1.yaml");
  writeFileSync(layout, layoutTransform(readFileSync(layout, "utf8")), "utf8");
  writeFileSync(join(root, "memory-variant-run.yaml"), `
schemaVersion: 1
id: memory-variant-run
moduleAssemblyRef: local-slg-test-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: core-3
modelLayoutRef: deterministic-model-layout-v1
player: { principalId: player-1, factionId: null }
mode: live
initialState: { kind: cold-start }
variant: { id: memory-variant, profilePatchRefs: [${variantRef}, model-decision], agentIds: null }
script: null
clock: { kind: realtime }
budget: { maxTokens: null, maxCost: null }
failurePolicy: strict
`, "utf8");
  writeFileSync(join(root, "model-decision.yaml"), `
schemaVersion: 1
profileId: model-decision
kind: variant
parent: null
patch:
  slots:
    decision: { module: agent.decision.model, config: {} }
`, "utf8");
  return root;
}

async function variantHost(variantRef: string): Promise<RunningHost> {
  const host = await startHost({
    dataDir: temporaryDirectory(), playerToken: "variant-player", consoleToken: "variant-console",
    assemblyRef: "local-slg-test-v1", rosterRef: "core-3",
    configRoot: variantConfig(variantRef), runSpecRef: "memory-variant-run",
  } satisfies HostOptions);
  hosts.push(host);
  return host;
}

function playerAuth(host: RunningHost): AuthContext {
  return {
    principalId: "player-1", kind: "player", roles: ["player"], worldId: host.worldId,
    branchId: host.branchId, actingAsAgentId: null, controllerEpoch: null, turnId: null, turnLeaseEpoch: null,
  };
}

/** 开局、让时钟进入 running，随后由玩家对目标 Agent 说一句话；返回该对白事件的 ID。 */
function startAndSpeak(host: RunningHost, text: string): string {
  const execute = (type: "campaign.start" | "dialogue.say", payload: Json, commandId: string) => {
    const receipt = host.authority.commands.execute(playerAuth(host), gameCommandEnvelope(type, payload, commandId));
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ commandStatus: "accepted" });
    return receipt;
  };
  execute("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001");
  host.storage.transact((tx) => {
    const table = tx.branch(host.branchId).table("clock");
    const row = table.get({});
    if (row === null) throw new Error("测试分支缺少时钟行");
    table.put({ ...row, mode: "running", run_version: Number(row["run_version"]) + 1 });
  });
  return dialogueEventId(execute("dialogue.say", { targetAgentId: target, text }, "cmd-000000000002"));
}

/**
 * 开局后连续说三句话，返回第三句对应的事件 ID。
 * 前两句依次各自触发一轮 turn，它们的对白成为第三轮冻结观察中的非触发对白，
 * 因此历史段会包含可识别文本；只靠一句无法让历史段非空。
 */
function startAndSpeakThrice(host: RunningHost, lines: readonly [string, string, string]): string {
  const execute = (type: "campaign.start" | "dialogue.say", payload: Json, commandId: string) => {
    const receipt = host.authority.commands.execute(playerAuth(host), gameCommandEnvelope(type, payload, commandId));
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ commandStatus: "accepted" });
    return receipt;
  };
  execute("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001");
  host.storage.transact((tx) => {
    const table = tx.branch(host.branchId).table("clock");
    const row = table.get({});
    if (row === null) throw new Error("测试分支缺少时钟行");
    table.put({ ...row, mode: "running", run_version: Number(row["run_version"]) + 1 });
  });
  dialogueEventId(execute("dialogue.say", { targetAgentId: target, text: lines[0] }, "cmd-000000000002"));
  dialogueEventId(execute("dialogue.say", { targetAgentId: target, text: lines[1] }, "cmd-000000000003"));
  return dialogueEventId(execute("dialogue.say", { targetAgentId: target, text: lines[2] }, "cmd-000000000004"));
}

/** 取出回执里唯一的事件 ID；缺失说明命令没有被接受，直接失败而不是用非空断言。 */
function dialogueEventId(receipt: { readonly acceptedEventIds: readonly string[] }): string {
  const [eventId] = receipt.acceptedEventIds;
  if (eventId === undefined) throw new Error(`对白命令没有产生事件：${JSON.stringify(receipt)}`);
  return eventId;
}

/** 等待该事件触发的 turn 结束并返回 turn 行。 */
async function terminalTurn(host: RunningHost, eventId: string): Promise<Record<string, unknown>> {
  return vi.waitFor(() => {
    const turnId = host.storage.transact((tx) => {
      const trigger = tx.branch(host.branchId).table("triggers")
        .list({ source_ref: eventId, agent_id: target })[0];
      return typeof trigger?.["consumed_by_turn_id"] === "string" ? trigger["consumed_by_turn_id"] : null;
    });
    expect(turnId).not.toBeNull();
    const row = host.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: turnId }));
    expect(row?.["ended_at"]).toEqual(expect.any(String));
    return row as Record<string, unknown>;
  }, { timeout: 15_000, interval: 25 });
}

interface ContextArtifact {
  readonly segments?: readonly { readonly kind?: string; readonly text?: string }[];
}

/** 读取 turn 的 context 阶段 artifact，作为实际入模内容的证据。 */
function contextArtifact(host: RunningHost, turn: Record<string, unknown>): ContextArtifact {
  const stages = turn["effective_json"] as { stage: string; effective: { artifactId?: string } | null }[];
  const artifactId = stages.find(({ stage }) => stage === "turn.context")?.effective?.artifactId;
  if (artifactId === undefined) throw new Error(`turn 缺少 context artifact：${JSON.stringify(turn)}`);
  const stored = host.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
  const body = stored?.["body"];
  if (!(body instanceof Uint8Array)) throw new Error("context artifact 正文缺失");
  return JSON.parse(new TextDecoder().decode(body)) as ContextArtifact;
}

/** 从 context artifact 取出记忆段文本；没有记忆段时返回空串。 */
function memorySegmentText(artifact: ContextArtifact): string {
  return artifact.segments?.find((segment) => segment.kind === "memory")?.text ?? "";
}

const memoryVariants = [
  "memory-m0-window",
  "memory-m1-structured-ledger",
  "memory-m2-stream-reflection",
  "memory-m3-layered-hybrid",
] as const;

describe("记忆主组入模差异", () => {
  it("四个主组在同一输入下的记忆段互不相同", async () => {
    const segments = new Map<string, string>();
    for (const variant of memoryVariants) {
      const host = await variantHost(variant);
      const turn = await terminalTurn(host, startAndSpeak(host, "请确认水闸轮换的方案。"));
      expect(turn["status"]).toBe("completed");
      segments.set(variant, memorySegmentText(contextArtifact(host, turn)));
    }

    // 四组两两不同：任一策略若实际入模相同，说明该槽位没有真正改变输入。
    for (const [left, leftText] of segments) {
      for (const [right, rightText] of segments) {
        if (left === right) continue;
        expect(leftText, `${left} 与 ${right} 的记忆段不应相同`).not.toBe(rightText);
      }
    }
  });

  it("M3 的记忆段以完整核心块开头，且核心块不超过配置上限", async () => {
    const host = await variantHost("memory-m3-layered-hybrid");
    const turn = await terminalTurn(host, startAndSpeak(host, "请确认水闸轮换的方案。"));
    const memory = memorySegmentText(contextArtifact(host, turn));
    expect(memory.length).toBeGreaterThan(0);

    // 核心块是固定模板的多行文本，首行以「【核心记忆：」开头，其后依次是职责、价值、目标、当前关注。
    // 断言整块前缀而不是首行长度：核心块本来就是多行，单看首行无法证明它完整且受预算约束。
    expect(memory.startsWith("【核心记忆：")).toBe(true);
    const coreLines = memory.split("\n").slice(0, 5);
    expect(coreLines).toHaveLength(5);
    expect(coreLines[1]).toMatch(/^职责：/u);
    expect(coreLines[2]).toMatch(/^价值：/u);
    expect(coreLines[3]).toMatch(/^目标：/u);
    expect(coreLines[4]).toMatch(/^当前关注：/u);

    // 核心块全文（含被截断的情形）是记忆段的前缀，且长度受 coreBlockMaxTokens 约束；
    // 该配置为 300，实现按字符截断，因此整块字符数不得超过 300。
    const coreBlock = coreLines.join("\n");
    expect(memory.startsWith(coreBlock)).toBe(true);
    expect(coreBlock.length).toBeLessThanOrEqual(300);
  });

  it("M0 current 的会话窗口为 0，确实丢弃可识别的历史，而 M0 window 保留它", async () => {
    const lines = [
      "第一轮：请确认水闸轮换。",
      "第二轮：那隘口那条路呢？",
      "第三轮：这么说定了。",
    ] as const;
    const currentHost = await variantHost("memory-m0-current");
    const currentArtifact = contextArtifact(currentHost, await terminalTurn(
      currentHost, startAndSpeakThrice(currentHost, lines),
    ));
    const currentHistory = currentArtifact.segments?.find((segment) => segment.kind === "history")?.text ?? "";
    expect(currentHistory).toBe("");
    // M0 没有长期记忆，记忆段不应出现账本条目。
    expect(memorySegmentText(currentArtifact)).toBe("");

    // 同一输入下窗口组必须看得到历史，否则上一条断言无法区分「窗口为 0」与「历史本就不存在」。
    const windowHost = await variantHost("memory-m0-window");
    const windowArtifact = contextArtifact(windowHost, await terminalTurn(
      windowHost, startAndSpeakThrice(windowHost, lines),
    ));
    const windowHistory = windowArtifact.segments?.find((segment) => segment.kind === "history")?.text ?? "";
    expect(windowHistory.length).toBeGreaterThan(0);
    // 窗口组至少看到此前的对白轮次；内容可以是任一侧的发言，因此只断言历史非空且带对白序号。
    expect(windowHistory).toContain("dlg-");
  });
});
