/**
 * 核心职责：验证切片 A 从玩家发言、模型 turn、持久证据到控制台 trace 的最小贯通路径。
 * 交互契约：使用真实测试装配、SQLite 与 deterministic transport；不访问端口或真实供应商。
 * 约束与禁忌：禁止用静态夹具替代命令、记忆、artifact 与授权读接口的真实调用。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHost, type RunningHost } from "@world-prism/app-server";
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
} from "@world-prism/contracts";
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
  const root = mkdtempSync(join(tmpdir(), "world-prism-slice-a-"));
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
    const turnList = turnsResponseSchema.parse(turnsResponse.json()).turns;
    const listedTurn = turnList.find((turn) => turn.turnId === turnId);
    expect(listedTurn).toBeDefined();
    expect(listedTurn?.triggerKinds.length).toBeGreaterThan(0);

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
    const trace = traceResponseSchema.parse(traceResponse.json());
    expect(trace.root.children.length).toBeGreaterThan(0);
    expect(trace.root.startedAt).not.toBeNull();
    expect(Date.parse(trace.root.startedAt ?? "")).toBeGreaterThan(Date.now() - 120_000);

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
    const observations = observationsResponseSchema.parse(observationsResponse.json()).observations;
    expect(observations.length).toBeGreaterThan(0);
    const nextObservation = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents/human-independent/observations?branchId=${host.branchId}&fromSeq=${observations[0]!.observationSeq}&limit=1`,
      headers,
    });
    expect(observationsResponseSchema.parse(nextObservation.json()).observations).toHaveLength(1);

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
      tx.all("SELECT type, subject_id, payload_json FROM lifecycle_events WHERE type = 'ArtifactViewed'"))).toEqual([
      expect.objectContaining({ type: "ArtifactViewed", subject_id: "console-admin" }),
    ]);

    const replayResponse = await host.app.inject({
      method: "POST",
      url: `/api/v1/console/debug/turns/${turnId}/replay`,
      headers,
      payload: {},
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toMatchObject({ requestHashMatch: true });
    const canonicalArtifactId = host.storage.transact((tx) => {
      const attempts = tx.rows("model_attempts").list({ work_ref: turnId });
      const artifactId = attempts[0]?.["request_artifact_id"];
      if (typeof artifactId !== "string") throw new Error("expected request artifact");
      const artifact = tx.rows("artifacts").get({ artifact_id: artifactId });
      if (artifact === null) throw new Error("expected stored artifact");
      tx.rows("artifacts").put({ ...artifact, body: new TextEncoder().encode("1e400") });
      return artifactId;
    });
    const canonicalFailure = await host.app.inject({
      method: "POST",
      url: `/api/v1/console/debug/turns/${turnId}/replay`,
      headers,
      payload: {},
    });
    expect(canonicalFailure.json()).toMatchObject({
      requestHashMatch: false,
      differences: expect.arrayContaining([{
        path: canonicalArtifactId,
        expected: "canonical JSON",
        actual: null,
      }]),
    });
    const sensitiveFixture = "private-replay-fixture";
    host.storage.transact((tx) => {
      const artifacts = tx.rows("artifacts");
      const artifact = artifacts.get({ artifact_id: canonicalArtifactId });
      if (artifact === null) throw new Error("expected stored artifact");
      artifacts.put({ ...artifact, body: new TextEncoder().encode(`{"unclosed":"${sensitiveFixture}`) });
    });
    const malformedReplay = await host.app.inject({
      method: "POST",
      url: `/api/v1/console/debug/turns/${turnId}/replay`,
      headers,
      payload: {},
    });
    expect(malformedReplay.statusCode).toBe(200);
    expect(malformedReplay.json()).toMatchObject({
      requestHashMatch: false,
      differences: expect.arrayContaining([{
        path: canonicalArtifactId,
        expected: "valid JSON",
        actual: null,
      }]),
    });
    expect(malformedReplay.body).not.toContain(sensitiveFixture);
    host.storage.transact((tx) => {
      const attempts = tx.rows("model_attempts").list({ work_ref: turnId });
      const first = attempts[0];
      if (first === undefined) throw new Error("expected model attempt");
      tx.rows("model_attempts").put({ ...first, request_artifact_id: null });
    });
    const incompleteReplay = await host.app.inject({
      method: "POST",
      url: `/api/v1/console/debug/turns/${turnId}/replay`,
      headers,
      payload: {},
    });
    expect(incompleteReplay.json()).toMatchObject({ requestHashMatch: false });

    const missingTrace = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/traces/trc-000000000099",
      headers,
    });
    expect(missingTrace.statusCode).toBe(404);
    const missingArtifact = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/artifacts/art-000000000099?view=redacted",
      headers,
    });
    expect(missingArtifact.statusCode).toBe(404);
    const branchCompare = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/branches/compare?left=${host.branchId}&right=${host.branchId}&atSeq=0`,
      headers,
    });
    expect(branchCompare.statusCode).toBe(200);
    expect(branchCompare.json()).toMatchObject({ differences: [] });

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
    const wakeAudit = host.storage.transact((tx) => tx.get(
      "SELECT subject_id, payload_json FROM lifecycle_events WHERE branch_id = ? AND type = 'DebugWakeRequested'",
      [host.branchId],
    ));
    expect(wakeAudit?.["subject_id"]).toBe("human-independent");
    expect(JSON.parse(String(wakeAudit?.["payload_json"]))).toEqual({
      agentId: "human-independent",
      principalId: "console-admin",
      reason: "场景测试人工唤醒",
      operationId: "op-000000000009",
    });
    const conflictingWake = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/debug/agents/human-independent/wake",
      headers,
      payload: { reason: "不同原因", operationId: "op-000000000009" },
    });
    expect(conflictingWake.statusCode).toBe(409);
    expect(errorResponseSchema.parse(conflictingWake.json()).error.code).toBe("idempotency-conflict");
    const conflictingAgentWake = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/debug/agents/human-earth-alliance/wake",
      headers,
      payload: { reason: "场景测试人工唤醒", operationId: "op-000000000009" },
    });
    expect(conflictingAgentWake.statusCode).toBe(409);
    expect(errorResponseSchema.parse(conflictingAgentWake.json()).error.code).toBe("idempotency-conflict");
    host.storage.transact((tx) => {
      const activations = tx.branch(host.branchId).table("agent_activations");
      const activation = activations.get({ agent_id: "human-independent" });
      if (activation === null) throw new Error("missing Agent activation");
      activations.put({ ...activation, status: "dormant" });
    });
    const replayAfterPause = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/debug/agents/human-independent/wake",
      headers,
      payload: { reason: "场景测试人工唤醒", operationId: "op-000000000009" },
    });
    expect(replayAfterPause.statusCode).toBe(200);

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
    const snapshotBody = snapshot.json() as { readonly snapshotId: string };
    expect(snapshotBody).toMatchObject({ snapshotId: expect.any(String), worldTick: expect.any(Number) });
    const preview = await host.app.inject({
      method: "POST",
      url: "/api/v1/console/campaign/restore",
      headers,
      payload: {
        operationId: "op-000000000003",
        snapshotId: snapshotBody.snapshotId,
        dryRun: true,
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ ok: true, checks: expect.arrayContaining([
      expect.objectContaining({ name: "source-run", ok: true }),
      expect.objectContaining({ name: "checkpoint", ok: true }),
    ]) });
    expect(current).toBeGreaterThanOrEqual(0);
  });
});
