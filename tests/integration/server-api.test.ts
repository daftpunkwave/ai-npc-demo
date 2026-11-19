/**
 * 验证服务端 Fastify 应用的登录、会话、命令、回执、世界视图、时钟控制与访问控制。
 * 依赖真实 authority/存储与注入的投影/时钟/存档回调；WS 用例在真实监听端口上连接并验证订阅、重放与撤销。
 * 禁止用静态回执替代命令网关，也不在用例间复用连接或服务器。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
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
const clients: StreamClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
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

interface AppOverrides {
  readonly projection?: () => PlayerProjection;
  readonly reset?: () => { readonly branchId: string; readonly clock: ClockView };
  readonly now?: () => number;
}

async function appFor(harness: GameHarness, overrides: AppOverrides = {}) {
  const save = new SqliteSaveService(harness.storage, harness.host);
  const app = await createServerApp({
    authority: harness.authority,
    storage: harness.storage,
    worldId: harness.worldId,
    branchId: harness.branchId,
    assembly,
    projection: overrides.projection ?? (() => projection(clockView(harness))),
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
    reset: overrides.reset ?? (() => ({ branchId: harness.branchId, clock: clockView(harness) })),
    identities: [
      { token: "player-token", auth: playerAuth(harness) },
      { token: "console-token", auth: operatorAuth(harness) },
      { token: "researcher-token", auth: { ...operatorAuth(harness), principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } },
    ],
    ids: (prefix: string) => harness.host.ids(prefix),
    tokens: (kind) => `${kind}-${randomUUID()}`,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  apps.push(app);
  return app;
}

async function login(app: Awaited<ReturnType<typeof createServerApp>>, token: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

interface StreamSocket {
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { readonly code: number; readonly reason: string }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  send(data: string): void;
  close(): void;
}

interface StreamCloseInfo {
  readonly code: number;
  readonly reason: string;
}

interface StreamClient {
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  expectNoMessage(ms: number): Promise<void>;
  closed(timeoutMs?: number): Promise<StreamCloseInfo>;
  send(message: Record<string, unknown>): void;
  close(): void;
}

const StreamWebSocket = (globalThis as unknown as {
  WebSocket: new (url: string) => StreamSocket;
}).WebSocket;

/** 建立真实 WS 连接，按到达顺序缓存消息并保留关闭原因。 */
function connectStream(url: string): StreamClient {
  const socket = new StreamWebSocket(url);
  const pending: Record<string, unknown>[] = [];
  const messageWaiters: Array<(message: Record<string, unknown>) => void> = [];
  const closeWaiters: Array<(info: StreamCloseInfo) => void> = [];
  let closeInfo: StreamCloseInfo | null = null;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = messageWaiters.shift();
    if (waiter === undefined) {
      pending.push(message);
      return;
    }
    waiter(message);
  });
  socket.addEventListener("close", (event) => {
    const info: StreamCloseInfo = { code: event.code, reason: event.reason };
    closeInfo = info;
    for (const waiter of closeWaiters.splice(0)) {
      waiter(info);
    }
  });
  socket.addEventListener("error", () => {
    // 连接错误由 close 事件或等待超时体现，避免未处理的 error。
  });

  const next = (timeoutMs = 3000): Promise<Record<string, unknown>> => {
    const queued = pending.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (message: Record<string, unknown>): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(message);
      };
      timer = setTimeout(() => {
        const index = messageWaiters.indexOf(waiter);
        if (index >= 0) {
          messageWaiters.splice(index, 1);
        }
        reject(new Error("等待 WS 消息超时"));
      }, timeoutMs);
      messageWaiters.push(waiter);
    });
  };

  const closed = (timeoutMs = 3000): Promise<StreamCloseInfo> => {
    if (closeInfo !== null) {
      return Promise.resolve(closeInfo);
    }
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (info: StreamCloseInfo): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(info);
      };
      timer = setTimeout(() => {
        reject(new Error("等待 WS 关闭超时"));
      }, timeoutMs);
      closeWaiters.push(waiter);
    });
  };

  const client: StreamClient = {
    next,
    async expectNoMessage(ms) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
      if (pending.length > 0) {
        throw new Error(`收到未预期的 WS 消息: ${JSON.stringify(pending[0])}`);
      }
    },
    closed,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      try {
        socket.close();
      } catch {
        // 已关闭的连接无需处理。
      }
    },
  };
  clients.push(client);
  return client;
}

async function listen(app: Awaited<ReturnType<typeof createServerApp>>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("没有监听端口");
  }
  return address.port;
}

async function ticketFor(app: Awaited<ReturnType<typeof createServerApp>>, session: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/streams/ticket",
    headers: { authorization: `Bearer ${session}` },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly ticket: string }).ticket;
}

function openStream(port: number, ticket: string): StreamClient {
  return connectStream(`ws://127.0.0.1:${port}/api/v1/streams?ticket=${encodeURIComponent(ticket)}`);
}

/** 直接用 HTTP Upgrade 发起握手，用于验证 Origin 在升级前被拒绝。 */
function rawUpgradeStatus(port: number, origin: string, ticket: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: `/api/v1/streams?ticket=${encodeURIComponent(ticket)}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: origin,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("服务端 API", () => {
  it("登录、会话、命令、回执与世界视图", async () => {

    const value = await createTrackedGameHarness(active);

    const app = await appFor(value);

    const session = await login(app, "player-token");
    expect(await login(app, "player-token")).not.toBe(session);

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

  it("WS 首次订阅返回快照，命令后推送增量", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello", principalId: "player-1", channels: ["player"] });

    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", channel: "player", streamSeq: 0 });

    const command = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd"));
    expect((await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: command })).statusCode).toBe(200);
    expect(await client.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 1 });

    client.send({ type: "subscribe", channel: "player", fromStreamSeq: 0 });
    expect(await client.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 1 });
    client.send({ type: "subscribe", channel: "player", fromStreamSeq: 999 });
    expect(await client.next()).toMatchObject({ type: "snapshot", channel: "player", streamSeq: 1 });
  });

  it("未订阅时世界变化不推送，订阅后收到快照与增量", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const session = await login(app, "player-token");
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello" });

    app.notifyWorldChanged();
    await client.expectNoMessage(100);

    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", channel: "player", streamSeq: 1 });
    app.notifyWorldChanged();
    expect(await client.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 2 });
  });

  it("频道按会话角色划分，玩家不能订阅控制台频道", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);

    const playerSession = await login(app, "player-token");
    const playerClient = openStream(port, await ticketFor(app, playerSession));
    expect(await playerClient.next()).toMatchObject({ type: "hello", channels: ["player"] });
    playerClient.send({ type: "subscribe", channel: "console.health", fromStreamSeq: null });
    expect(await playerClient.next()).toMatchObject({ type: "error", code: "forbidden" });

    const consoleSession = await login(app, "console-token");
    const consoleClient = openStream(port, await ticketFor(app, consoleSession));
    expect(await consoleClient.next()).toMatchObject({ type: "hello", channels: ["console.health"] });
    consoleClient.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await consoleClient.next()).toMatchObject({ type: "error", code: "forbidden" });

    const researcherSession = await login(app, "researcher-token");
    const researcherClient = openStream(port, await ticketFor(app, researcherSession));
    expect(await researcherClient.next()).toMatchObject({
      type: "hello",
      channels: ["console.health", "console.timeline", "console.turns"],
    });
    researcherClient.send({ type: "subscribe", channel: "console.health", fromStreamSeq: null });
    await researcherClient.expectNoMessage(50);
  });

  it("同会话断线重连按旧游标补发连续增量", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const session = await login(app, "player-token");

    const first = openStream(port, await ticketFor(app, session));
    expect(await first.next()).toMatchObject({ type: "hello" });
    first.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await first.next()).toMatchObject({ type: "snapshot", streamSeq: 0 });
    app.notifyWorldChanged();
    expect(await first.next()).toMatchObject({ type: "delta", streamSeq: 1 });
    app.notifyWorldChanged();
    expect(await first.next()).toMatchObject({ type: "delta", streamSeq: 2 });
    first.close();
    await first.closed();

    // 断线期间的增量仍进入该会话的重放缓冲。
    app.notifyWorldChanged();
    app.notifyWorldChanged();

    const second = openStream(port, await ticketFor(app, session));
    expect(await second.next()).toMatchObject({ type: "hello" });
    second.send({ type: "subscribe", channel: "player", fromStreamSeq: 2 });
    expect(await second.next()).toMatchObject({ type: "delta", streamSeq: 3 });
    expect(await second.next()).toMatchObject({ type: "delta", streamSeq: 4 });
    await second.expectNoMessage(50);

    // 另一个会话没有这些增量，不能复用原会话的重放缓冲。
    const otherSession = await login(app, "player-token");
    const isolated = openStream(port, await ticketFor(app, otherSession));
    expect(await isolated.next()).toMatchObject({ type: "hello" });
    isolated.send({ type: "subscribe", channel: "player", fromStreamSeq: 2 });
    expect(await isolated.next()).toMatchObject({ type: "snapshot", streamSeq: 4 });
  });

  it("增量超过 200 条后旧游标缺口返回快照", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const session = await login(app, "player-token");

    const first = openStream(port, await ticketFor(app, session));
    expect(await first.next()).toMatchObject({ type: "hello" });
    first.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await first.next()).toMatchObject({ type: "snapshot", streamSeq: 0 });
    first.close();
    await first.closed();

    for (let index = 0; index < 205; index += 1) {
      app.notifyWorldChanged();
    }

    const second = openStream(port, await ticketFor(app, session));
    expect(await second.next()).toMatchObject({ type: "hello" });
    second.send({ type: "subscribe", channel: "player", fromStreamSeq: 0 });
    expect(await second.next()).toMatchObject({ type: "snapshot", channel: "player", streamSeq: 205 });
    await second.expectNoMessage(50);
  });

  it("分支切换后旧游标重连得到完整快照，不重放旧分支增量", async () => {
    const value = await createTrackedGameHarness(active);
    let worldTick = 0;
    const app = await appFor(value, {
      projection: () => projection({ ...clockView(value), worldTick }),
      reset: () => {
        worldTick = 7;
        return { branchId: "br-000000000001", clock: { ...clockView(value), worldTick } };
      },
    });
    const port = await listen(app);
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };

    const first = openStream(port, await ticketFor(app, session));
    expect(await first.next()).toMatchObject({ type: "hello" });
    first.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await first.next()).toMatchObject({ type: "snapshot", streamSeq: 0, data: { clock: { worldTick: 0 } } });
    app.notifyWorldChanged();
    expect(await first.next()).toMatchObject({ type: "delta", streamSeq: 1 });

    const reset = await app.inject({ method: "POST", url: "/api/v1/campaign/reset", headers: auth });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ branchId: "br-000000000001" });
    expect(await first.next()).toMatchObject({
      type: "snapshot",
      channel: "player",
      streamSeq: 2,
      data: { clock: { worldTick: 7 } },
    });
    first.close();
    await first.closed();

    app.notifyWorldChanged();
    const second = openStream(port, await ticketFor(app, session));
    expect(await second.next()).toMatchObject({ type: "hello" });
    second.send({ type: "subscribe", channel: "player", fromStreamSeq: 1 });
    expect(await second.next()).toMatchObject({
      type: "snapshot",
      channel: "player",
      streamSeq: 3,
      data: { clock: { worldTick: 7 } },
    });
    await second.expectNoMessage(50);
  });

  it("错误 Origin、无效票据与未知频道不会加入推送", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const session = await login(app, "player-token");

    expect(await rawUpgradeStatus(port, "http://evil.example", "ticket-invalid")).toBe(403);

    const invalid = openStream(port, "ticket-invalid");
    expect((await invalid.closed()).code).toBe(4401);

    const ticket = await ticketFor(app, session);
    const client = openStream(port, ticket);
    expect(await client.next()).toMatchObject({ type: "hello" });
    const reused = openStream(port, ticket);
    expect((await reused.closed()).code).toBe(4401);

    client.send({ type: "subscribe", channel: "console.health", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
    app.notifyWorldChanged();
    await client.expectNoMessage(100);

    client.send({ type: "subscribe", channel: "unknown-channel", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "error", code: "validation" });

    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", streamSeq: 1 });
  });

  it("注销关闭该会话的连接并使其票据失效，不影响其他会话", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const sessionA = await login(app, "player-token");
    const sessionB = await login(app, "player-token");
    const unusedTicket = await ticketFor(app, sessionA);

    const idle = openStream(port, await ticketFor(app, sessionA));
    expect(await idle.next()).toMatchObject({ type: "hello" });
    const subscribed = openStream(port, await ticketFor(app, sessionA));
    expect(await subscribed.next()).toMatchObject({ type: "hello" });
    subscribed.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await subscribed.next()).toMatchObject({ type: "snapshot" });

    const other = openStream(port, await ticketFor(app, sessionB));
    expect(await other.next()).toMatchObject({ type: "hello" });
    other.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await other.next()).toMatchObject({ type: "snapshot" });

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${sessionA}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    expect((await idle.closed()).code).toBe(4401);
    expect((await subscribed.closed()).code).toBe(4401);

    // 并发或重复注销保持幂等。
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${sessionA}` },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true });

    const rejected = openStream(port, unusedTicket);
    expect((await rejected.closed()).code).toBe(4401);

    app.notifyWorldChanged();
    expect(await other.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 1 });
  });

  it("会话过期后订阅与推送被拒绝并关闭连接", async () => {
    const value = await createTrackedGameHarness(active);
    let current = Date.parse("2026-01-01T00:00:00.000Z");
    const app = await appFor(value, { now: () => current });
    const port = await listen(app);
    const session = await login(app, "player-token");

    const subscriber = openStream(port, await ticketFor(app, session));
    expect(await subscriber.next()).toMatchObject({ type: "hello" });
    current += 13 * 60 * 60 * 1000;
    subscriber.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect((await subscriber.closed()).code).toBe(4401);

    const session2 = await login(app, "player-token");
    const live = openStream(port, await ticketFor(app, session2));
    expect(await live.next()).toMatchObject({ type: "hello" });
    live.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await live.next()).toMatchObject({ type: "snapshot" });
    current += 13 * 60 * 60 * 1000;
    app.notifyWorldChanged();
    expect((await live.closed()).code).toBe(4401);

    // 票据自身仍在 30 秒内，但绑定的会话已过期，握手必须失败。
    const session3 = await login(app, "player-token");
    current += 12 * 60 * 60 * 1000 - 10_000;
    const unused = await ticketFor(app, session3);
    current += 20_000;
    const rejected = openStream(port, unused);
    expect((await rejected.closed()).code).toBe(4401);
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
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/commands",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
  });
});
