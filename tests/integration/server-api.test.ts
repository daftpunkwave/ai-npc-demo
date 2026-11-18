/**
 * 验证服务端 Fastify 应用的登录、会话、命令、回执、世界视图、时钟控制与访问控制。
 * 依赖真实 authority/存储与注入的投影/时钟/存档回调；不启动网络。
 * 禁止用静态回执替代命令网关。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  playerProjectionSchema,
  type ClockView,
  type PlayerProjection,
  type ResolvedModuleSet,
} from "@ai-npc/contracts";
import { createServerApp } from "@ai-npc/app-server";
import { SqliteSaveService } from "@ai-npc/mod-game-save-sqlite";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  operatorAuth,
  playerAuth,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];
const apps: Awaited<ReturnType<typeof createServerApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await disposeTrackedGameHarnesses(active);
});

function clockView(harness: GameHarness): ClockView {
  const row = harness.storage.transact((tx) => tx.branch(harness.branchId).table("clock").get({}));
  if (row === null) {
    throw new Error("缺少 clock");
  }
  const tick = Number(row["world_tick"]);
  return {
    worldTick: tick,
    day: Math.floor(tick / 24) + 1,
    hour: tick % 24,
    mode: row["mode"] as ClockView["mode"],
    runVersion: Number(row["run_version"]),
  };
}

function setClockMode(harness: GameHarness, mode: ClockView["mode"], expected: number): ClockView {
  harness.storage.transact((tx) => {
    const table = tx.branch(harness.branchId).table("clock");
    const row = table.get({});
    if (row === null || Number(row["run_version"]) !== expected) {
      throw new Error("时钟版本冲突");
    }
    table.put({ ...row, mode, run_version: Number(row["run_version"]) + 1, updated_at: harness.host.nowIso() });
  });
  return clockView(harness);
}

function projection(clock: ClockView): PlayerProjection {
  return playerProjectionSchema.parse({
    campaign: null,
    clock,
    map: { nodes: [], roads: [] },
    meters: {
      relayStability: { value: 45, level: "stable" },
      orchardWater: { value: 50, level: "stable" },
      migrationSafety: { value: 50, level: "stable" },
      watergateAllocation: "harbor-first",
    },
    stockpiles: [],
    teams: [],
    characters: [],
    tasks: [],
    agreements: [],
    invitations: [],
    conversations: [],
    inbox: [],
    notebook: [],
    awaitingReplyFrom: [],
    notifications: [],
  });
}

const assembly: ResolvedModuleSet = {
  realm: "server",
  protocolVersion: "1",
  modules: [],
  capabilities: [],
  assemblyHash: "test",
};

async function appFor(harness: GameHarness) {
  const save = new SqliteSaveService(harness.storage, harness.host);
  const app = await createServerApp({
    authority: harness.authority,
    storage: harness.storage,
    worldId: harness.worldId,
    branchId: harness.branchId,
    assembly,
    projection: () => projection(clockView(harness)),
    clock: () => clockView(harness),
    pause: (operationId: string, expected: number) => {
      void operationId;
      return setClockMode(harness, "paused", expected);
    },
    resume: (operationId: string, expected: number) => {
      void operationId;
      return setClockMode(harness, "running", expected);
    },
    save,
    identities: [
      { token: "player-token", auth: playerAuth(harness) },
      { token: "console-token", auth: operatorAuth(harness) },
    ],
  });
  apps.push(app);
  return app;
}

async function login(app: Awaited<ReturnType<typeof createServerApp>>, token: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

describe("服务端 API", () => {
  it("登录、会话、命令、回执与世界视图", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };
    const me = await app.inject({ method: "GET", url: "/api/v1/session", headers: auth });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ principalId: "player-1", roles: ["player"], branchId: value.branchId });

    const command = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd"));
    const executed = await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: command });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ commandStatus: "accepted", commandId: command.commandId });

    const receipt = await app.inject({ method: "GET", url: `/api/v1/commands/${command.commandId}`, headers: auth });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({ commandStatus: "accepted", commandId: command.commandId });

    const view = await app.inject({ method: "GET", url: "/api/v1/world/view", headers: auth });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ projection: { clock: { worldTick: 0 } } });
  });

  it("暂停与继续更新时钟版本", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };
    const before = clockView(value);
    const paused = await app.inject({ method: "POST", url: "/api/v1/campaign/pause", headers: auth, payload: { operationId: "op-000000000001", expectedRunVersion: before.runVersion } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ mode: "paused", runVersion: before.runVersion + 1 });
    const resumed = await app.inject({ method: "POST", url: "/api/v1/campaign/resume", headers: auth, payload: { operationId: "op-000000000002", expectedRunVersion: before.runVersion + 1 } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ mode: "running", runVersion: before.runVersion + 2 });
  });

  it("拒绝错误 Origin 与玩家访问控制台", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const badOrigin = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { origin: "http://evil.example" }, payload: { token: "player-token" } });
    expect(badOrigin.statusCode).toBe(403);
    const session = await login(app, "player-token");
    const forbidden = await app.inject({ method: "GET", url: "/api/v1/console/health", headers: { authorization: `Bearer ${session}` } });
    expect(forbidden.statusCode).toBe(403);
    const consoleSession = await login(app, "console-token");
    const allowed = await app.inject({ method: "GET", url: "/api/v1/console/health", headers: { authorization: `Bearer ${consoleSession}` } });
    expect(allowed.statusCode).toBe(200);
  });
});
