/**
 * 验证模型调用的失败证据、触发消费语义与模型替换标记。
 * 夹具注入协议失败与替换响应，经真实宿主与确定性装配执行完整 turn。
 * 禁止发起真实模型请求、占用端口或修改开发存档。
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHost, type HostOptions, type RunningHost } from "@ai-npc/app-server";
import { modelRequestSchema, type AuthContext, type Json, type StorageRow } from "@ai-npc/contracts";
import { gameCommandEnvelope } from "./game-support";

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
  const root = mkdtempSync(join(tmpdir(), "ai-npc-model-turn-failure-"));
  roots.push(root);
  return root;
}

function fixtureConfig(lines: readonly Json[]): string {
  const root = rootDir();
  const config = join(root, "config");
  cpSync("config", config, { recursive: true });
  const fixtures = join(root, "tests", "fixtures", "model");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, "default.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  const layout = join(config, "model-layouts", "deterministic-model-layout-v1.yaml");
  writeFileSync(layout, readFileSync(layout, "utf8"), "utf8");
  return config;
}

async function modelHost(lines: readonly Json[]) {
  const host = await startHost({
    dataDir: rootDir(), configRoot: fixtureConfig(lines), playerToken: "model-player", consoleToken: "model-console",
    assemblyRef: "local-slg-test-v1", rosterRef: "core-3",
  } satisfies HostOptions);
  opened.push(host);
  return host;
}

function runCampaign(host: RunningHost): AuthContext {
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
    clock.put({ ...row, mode: "running", world_tick: 0, run_version: Number(row["run_version"]) + 1 });
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

function turnFor(host: RunningHost, eventId: string): Promise<StorageRow> {
  return vi.waitFor(() => {
    const turn = host.storage.transact((tx) => {
      const trigger = tx.branch(host.branchId).table("triggers").list({ source_ref: eventId, agent_id: target })[0];
      return typeof trigger?.["consumed_by_turn_id"] === "string"
        ? tx.rows("turn_runs").get({ turn_id: trigger["consumed_by_turn_id"] }) : null;
    });
    expect(turn).not.toBeNull();
    expect(turn?.["ended_at"]).toEqual(expect.any(String));
    return turn!;
  }, { timeout: 15_000, interval: 20 });
}

function attempts(host: RunningHost, turnId: string): readonly StorageRow[] {
  return host.storage.transact((tx) => tx.rows("model_attempts").list({ work_ref: turnId }));
}

interface SpanWithAttrs extends Record<string, unknown> {
  readonly attrs: Record<string, unknown>;
}

function spansOf(host: RunningHost, turnId: string, name: string): readonly SpanWithAttrs[] {
  return host.storage.transact((tx) => tx.rows("trace_spans").list({ turn_id: turnId, name }))
    .map((row) => {
      const attrs = row["attrs_json"];
      const parsed = (typeof attrs === "string" ? JSON.parse(attrs) : attrs) as Record<string, unknown>;
      return { ...row, attrs: parsed } as SpanWithAttrs;
    });
}

describe("模型调用失败证据与替换标记", () => {
  it("夹具协议失败使 turn 终结为 model-failed，触发保持已消费且预算按预留结算", async () => {
    const host = await modelHost([
      { id: "inject-protocol", match: { purpose: "decision", agentId: target, triggerPrincipalCount: 1, round: 1 },
        response: { error: { kind: "protocol" } } },
    ]);
    const eventId = startConversation(host, "我想请你护送一趟。");
    const turn = await turnFor(host, eventId);
    expect(turn).toMatchObject({ status: "failed", terminal_reason: "model-failed" });
    const turnId = String(turn["turn_id"]);
    const decisionAttempts = attempts(host, turnId).filter((row) => row["purpose"] === "decision");
    expect(decisionAttempts).toHaveLength(1);
    expect(decisionAttempts[0]).toMatchObject({ status: "failed", is_effective: 0, error_json: { kind: "protocol" } });
    const ledger = host.storage.transact((tx) => tx.rows("budget_ledger").list({ work_ref: turnId }));
    expect(ledger.length).toBeGreaterThan(0);
    for (const entry of ledger) {
      expect(entry["settled_at"]).toEqual(expect.any(String));
      expect(entry["usage_unknown"]).toBe(1);
    }
    const trigger = host.storage.transact((tx) =>
      tx.branch(host.branchId).table("triggers").list({ source_ref: eventId, agent_id: target })[0]);
    expect(trigger?.["consumed_by_turn_id"]).toBe(turnId);
  });

  it("供应商实际模型与挂载不一致时 attempt 与 turn 阶段都标记 model-substituted", async () => {
    const host = await modelHost([
      { id: "substituted", match: { purpose: "decision", agentId: target, triggerPrincipalCount: 1, round: 1 },
        response: { finishReason: "tool_calls", servedModel: "fallback-chat", fallbackUsed: true, toolCalls: [{
          name: "decision_submit", arguments: {
            stance: "inform", dialogueIntent: {
              kind: "acknowledge", audience: ["player-1"], tone: "neutral", reasonCode: "none", subjectRef: null, factRefs: [],
            },
            noteworthy: [], citedMemoryIds: [], decisionNote: "替换响应",
          },
        }] } },
    ]);
    const eventId = startConversation(host, "我想请你护送一趟。");
    const turn = await turnFor(host, eventId);
    expect(turn).toMatchObject({ status: "completed" });
    const turnId = String(turn["turn_id"]);
    const decisionAttempts = attempts(host, turnId).filter((row) => row["purpose"] === "decision");
    expect(decisionAttempts).toHaveLength(1);
    expect(decisionAttempts[0]).toMatchObject({ status: "succeeded" });
    const attemptSpans = spansOf(host, turnId, "model.attempt");
    const substitutedSpan = attemptSpans.find((span) => span["attrs"]["reason"] === "model-substituted");
    expect(substitutedSpan).toBeDefined();
    expect(substitutedSpan?.["attrs"]["servedModel"]).toBe("fallback-chat");
    expect(turn["effective_json"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "turn.model", reason: "model-substituted" }),
    ]));
    const decisionRequests = attempts(host, turnId).filter((row) => row["purpose"] === "decision").map((attempt) => {
      const body = host.storage.transact((tx) =>
        tx.rows("artifacts").get({ artifact_id: String(attempt["request_artifact_id"]) })?.["body"]);
      expect(body).toBeInstanceOf(Uint8Array);
      return modelRequestSchema.parse(JSON.parse(new TextDecoder().decode(body as Uint8Array))["request"]);
    });
    expect(decisionRequests).toHaveLength(1);
  });
});
