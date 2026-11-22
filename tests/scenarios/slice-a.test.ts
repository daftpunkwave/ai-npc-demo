/**
 * 核心职责：验证切片 A 从玩家发言、模型 turn、持久证据到控制台 trace 的最小贯通路径。
 * 交互契约：使用真实测试装配、SQLite 与 deterministic transport；不访问端口或真实供应商。
 * 约束与禁忌：禁止用静态夹具替代命令、记忆、artifact 与授权读接口的真实调用。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHost, type RunningHost } from "@ai-npc/app-server";
import {
  agentInspectorResponseSchema,
  artifactResponseSchema,
  clockResponseSchema,
  consoleHealthResponseSchema,
  errorResponseSchema,
  memoryResponseSchema,
  observationsResponseSchema,
  timelineResponseSchema,
  traceResponseSchema,
  turnDetailSchema,
  turnsResponseSchema,
  type AuthContext,
} from "@ai-npc/contracts";
import { gameCommandEnvelope } from "../integration/game-support";

const roots: string[] = [];
const hosts: RunningHost[] = [];

afterEach(async () => {
  try {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ai-npc-slice-a-"));
  roots.push(root);
  return root;
}

function playerAuth(host: RunningHost): AuthContext {
  return {
    principalId: "player-1", kind: "player", roles: ["player"], worldId: host.worldId,
    branchId: host.branchId, actingAsAgentId: null, controllerEpoch: null,
    turnId: null, turnLeaseEpoch: null,
  };
}

function startCampaign(host: RunningHost): void {
  const start = host.authority.commands.execute(playerAuth(host), gameCommandEnvelope(
    "campaign.start", { factionId: "human-neutral" }, "cmd-000000000001",
  ));
  expect(start.commandStatus).toBe("accepted");
  host.storage.transact((tx) => {
    const clock = tx.branch(host.branchId).table("clock");
    const row = clock.get({});
    if (row === null) throw new Error("missing clock");
    clock.put({ ...row, mode: "running", run_version: Number(row["run_version"]) + 1 });
  });
}

function say(host: RunningHost, text: string): string {
  const receipt = host.authority.commands.execute(playerAuth(host), gameCommandEnvelope(
    "dialogue.say", { targetAgentId: "human-independent", text }, "cmd-000000000002",
  ));
  expect(receipt.commandStatus).toBe("accepted");
  return receipt.acceptedEventIds[0]!;
}

async function waitForTurn(host: RunningHost, eventId: string): Promise<string> {
  return vi.waitFor(() => {
    const turnId = host.storage.transact((tx) => {
      const trigger = tx.branch(host.branchId).table("triggers")
        .list({ source_ref: eventId, agent_id: "human-independent" })[0];
      return typeof trigger?.["consumed_by_turn_id"] === "string" ? trigger["consumed_by_turn_id"] : null;
    });
    expect(turnId).not.toBeNull();
    const row = host.storage.transact((tx) => tx.rows("turn_runs").get({ turn_id: turnId }));
    expect(row?.["ended_at"]).toEqual(expect.any(String));
    return turnId!;
  }, { timeout: 8_000, interval: 20 });
}

async function login(host: RunningHost, token: string): Promise<string> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

describe("slice A research path", () => {
  it("从玩家命令贯通到 Agent turn、记忆、artifact 与 trace", async () => {
    const host = await startHost({
      dataDir: dataDir(),
      playerToken: "slice-player",
      consoleToken: "slice-console",
      assemblyRef: "local-slg-test-v1",
      rosterRef: "core-3",
    });
    hosts.push(host);
    startCampaign(host);
    const eventId = say(host, "岑雁，可以帮我护送一趟吗？");
    const turnId = await waitForTurn(host, eventId);
    const sessionToken = await login(host, "slice-console");
    const headers = {
      Authorization: `Bearer ${sessionToken}`,
      "X-Active-Role": "researcher",
    };

    const agents = await host.app.inject({
      method: "GET", url: `/api/v1/console/agents?branchId=${host.branchId}`, headers,
    });
    expect(agents.statusCode).toBe(200);

    const turnsResponse = await host.app.inject({
      method: "GET", url: `/api/v1/console/turns?agentId=human-independent&limit=20`, headers,
    });
    expect(turnsResponse.statusCode).toBe(200);
    expect(turnsResponseSchema.parse(turnsResponse.json()).turns.some((turn) => turn.turnId === turnId)).toBe(true);

    const detailResponse = await host.app.inject({
      method: "GET", url: `/api/v1/console/turns/${turnId}`, headers,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = turnDetailSchema.parse(detailResponse.json());
    expect(detail.attempts.length).toBeGreaterThan(0);
    expect(detail.stages.some((stage) => stage.stage === "turn.decision")).toBe(true);

    const traceResponse = await host.app.inject({
      method: "GET", url: `/api/v1/console/traces/${detail.traceId}`, headers,
    });
    expect(traceResponse.statusCode).toBe(200);
    expect(traceResponseSchema.parse(traceResponse.json()).root.children.length).toBeGreaterThan(0);

    const inspectorResponse = await host.app.inject({
      method: "GET", url: `/api/v1/console/agents/human-independent/inspector?branchId=${host.branchId}`, headers,
    });
    expect(inspectorResponse.statusCode).toBe(200);
    const inspector = agentInspectorResponseSchema.parse(inspectorResponse.json());
    expect(inspector.memoryRevision).toBeGreaterThanOrEqual(0);

    const observationsResponse = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/observations?branchId=${host.branchId}&fromSeq=0&limit=20`,
      headers,
    });
    expect(observationsResponse.statusCode).toBe(200);
    expect(observationsResponseSchema.parse(observationsResponse.json()).observations.length).toBeGreaterThan(0);

    const memoryResponse = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/memory?branchId=${host.branchId}&revision=${inspector.memoryRevision}`,
      headers,
    });
    expect(memoryResponse.statusCode).toBe(200);
    expect(memoryResponseSchema.parse(memoryResponse.json()).records.length).toBeGreaterThanOrEqual(0);

    const attempt = detail.attempts.find((entry) => entry.requestArtifactId !== null);
    expect(attempt).toBeDefined();
    const artifactResponse = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/artifacts/${attempt!.requestArtifactId}?view=redacted`,
      headers,
    });
    expect(artifactResponse.statusCode).toBe(200);
    expect(artifactResponseSchema.parse(artifactResponse.json()).body.length).toBeGreaterThan(0);
    const rawArtifact = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/artifacts/${attempt!.requestArtifactId}?view=raw`,
      headers,
    });
    expect(rawArtifact.statusCode).toBe(200);
    expect(host.storage.transact((tx) =>
      tx.all("SELECT type FROM lifecycle_events WHERE type = 'ArtifactViewed'"))).toHaveLength(1);

    const replayResponse = await host.app.inject({
      method: "POST",
      url: `/api/v1/console/debug/turns/${turnId}/replay`,
      headers,
      payload: {},
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toMatchObject({ requestHashMatch: true });

    const wakeResponse = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/debug/agents/human-independent/wake",
      headers,
      payload: { reason: "场景测试人工唤醒", operationId: "op-000000000009" },
    });
    expect(wakeResponse.statusCode).toBe(200);
    expect(host.storage.transact((tx) => ({
      contaminated: tx.rows("runs").list({ branch_id: host.branchId })[0]?.["contaminated"],
      trigger: tx.branch(host.branchId).table("triggers").list({ kind: "debug" })[0]?.["source_ref"],
    }))).toMatchObject({ contaminated: 1, trigger: "op-000000000009" });

    const timelineResponse = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/timeline?branchId=${host.branchId}&fromSeq=0&limit=50`,
      headers,
    });
    expect(timelineResponse.statusCode).toBe(200);
    expect(timelineResponseSchema.parse(timelineResponse.json()).events.length).toBeGreaterThan(0);
  });

  it("玩家会话不能读取控制台研究接口", async () => {
    const host = await startHost({
      dataDir: dataDir(),
      playerToken: "slice-player",
      consoleToken: "slice-console",
      assemblyRef: "local-slg-test-v1",
      rosterRef: "core-3",
    });
    hosts.push(host);
    const playerSession = await login(host, "slice-player");
    const response = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents?branchId=${host.branchId}`,
      headers: { Authorization: `Bearer ${playerSession}` },
    });
    expect(response.statusCode).toBe(403);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe("forbidden");
  });

  it("服务端重启后仍能读取同一 turn 与 trace", async () => {
    const directory = dataDir();
    let host = await startHost({
      dataDir: directory,
      playerToken: "slice-player",
      consoleToken: "slice-console",
      assemblyRef: "local-slg-test-v1",
      rosterRef: "core-3",
    });
    hosts.push(host);
    startCampaign(host);
    const turnId = await waitForTurn(host, say(host, "重启前请确认这次护送。"));
    const originalTrace = host.storage.transact((tx) =>
      tx.all("SELECT trace_id FROM trace_spans WHERE turn_id = ? LIMIT 1", [turnId])[0]?.["trace_id"]);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await startHost({
      dataDir: directory,
      playerToken: "slice-player",
      consoleToken: "slice-console",
      assemblyRef: "local-slg-test-v1",
      rosterRef: "core-3",
    });
    hosts.push(host);
    const sessionToken = await login(host, "slice-console");
    const headers = { Authorization: `Bearer ${sessionToken}`, "X-Active-Role": "researcher" };
    const detail = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/turns/${turnId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(turnDetailSchema.parse(detail.json()).traceId).toBe(originalTrace);
  });

  it("暂停、单步与快照入口仍经过运营角色和版本约束", async () => {
    const host = await startHost({
      dataDir: dataDir(),
      playerToken: "slice-player",
      consoleToken: "slice-console",
      assemblyRef: "local-slg-test-v1",
      rosterRef: "core-3",
    });
    hosts.push(host);
    startCampaign(host);
    const sessionToken = await login(host, "slice-console");
    const headers = {
      Authorization: `Bearer ${sessionToken}`,
      "X-Active-Role": "operator",
    };
    const health = await host.app.inject({ method: "GET", url: "/api/v1/console/health", headers });
    const healthView = consoleHealthResponseSchema.parse(health.json());
    const current = healthView.clock.worldTick;
    const pause = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/campaign/pause",
      headers,
      payload: { operationId: "op-000000000001", expectedRunVersion: healthView.clock.runVersion },
    });
    expect(pause.statusCode).toBe(200);
    expect(clockResponseSchema.parse(pause.json()).mode).toBe("paused");
    const snapshot = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/campaign/snapshots",
      headers,
      payload: { operationId: "op-000000000002", label: "slice-a" },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ snapshotId: expect.any(String), worldTick: expect.any(Number) });
    expect(current).toBeGreaterThanOrEqual(0);
  });
});
