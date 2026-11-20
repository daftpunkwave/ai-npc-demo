/**
 * 验证服务端宿主 bootstrap：真实存储、内容、authority、在线分支、HTTP 应用、多角色令牌、监听失败、断线自动暂停与启动/关闭清理。
 * 依赖临时数据目录、content 包与冻结的 RunSpec/manifest；不监听固定端口。
 * 禁止用假存储替代首次启动路径，也禁止用当前入参覆盖已冻结的在线 run。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssemblyDescriptor, AuthContext, Json, ModuleDefinition, StorageCell } from "@ai-npc/contracts";
import {
  campaignResponseSchema,
  capabilityIdSchema,
  conversationResponseSchema,
  errorResponseSchema,
  sessionAssemblyResponseSchema,
} from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { clockConfigSchema } from "@ai-npc/mod-game-clock-controlled";
import { storageModuleDefinition } from "@ai-npc/mod-platform-storage-sqlite";
import { transportModuleDefinition } from "@ai-npc/mod-transport-http-ws-fastify";
import {
  disposeInReverse,
  loadAssembly,
  serverModuleDefinitions,
  startHost,
  type RunningHost,
} from "@ai-npc/app-server";
import { gameCommandEnvelope } from "./game-support";

const hosts: RunningHost[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => host.close()));
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-npc-host-test-"));
  dirs.push(dir);
  return dir;
}

/** 当前在线 run 的持久化行；测试只经 StoragePort 读取。 */
function liveRun(host: RunningHost): Readonly<Record<string, StorageCell>> {
  const row = host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" })[0]);
  if (row === undefined) {
    throw new Error("缺少 live run");
  }
  return row;
}

/** 用启动令牌登录并返回会话令牌。 */
async function loginSession(host: RunningHost, token: string): Promise<string> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly sessionToken: string }).sessionToken;
}

/** 申请一次性 WS 票据。 */
async function ticketFor(host: RunningHost, session: string): Promise<string> {
  const response = await host.app.inject({
    method: "POST",
    url: "/api/v1/streams/ticket",
    headers: { authorization: `Bearer ${session}` },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { readonly ticket: string }).ticket;
}

/** 解析持久化的在线入口：别名指向的分支与绑定 run。 */
function onlineEntry(host: RunningHost): {
  readonly branch: Record<string, StorageCell>;
  readonly run: Record<string, StorageCell>;
  readonly branchId: string;
  readonly runId: string;
} {
  const alias = host.storage.transact((tx) => tx.rows("world_aliases").get({ alias: "online" }));
  if (alias === null) {
    throw new Error("缺少 world_aliases('online')");
  }
  const branchId = String(alias["branch_id"]);
  const branch = host.storage.transact((tx) => tx.rows("branches").get({ branch_id: branchId }));
  if (branch === null) {
    throw new Error(`缺少在线分支 ${branchId}`);
  }
  const runId = String(branch["run_id"]);
  const run = host.storage.transact((tx) => tx.rows("runs").get({ run_id: runId }));
  if (run === null) {
    throw new Error(`缺少在线 run ${runId}`);
  }
  return { branch, run, branchId, runId };
}

/** 测试夹具：把指定分支的逻辑时钟拨到给定 tick 并保持暂停。 */
function setBranchClock(host: RunningHost, branchId: string, worldTick: number): void {
  host.storage.transact((tx) => {
    const table = tx.branch(branchId).table("clock");
    const row = table.get({});
    if (row === null) {
      throw new Error(`分支 ${branchId} 缺少时钟行`);
    }
    table.put({
      ...row,
      world_tick: worldTick,
      mode: "paused",
      step_target_tick: null,
      run_version: Number(row["run_version"]) + 1,
      updated_at: new Date().toISOString(),
    });
  });
}

/** 取一个当前空闲的本机端口，避免与开发服务器或其他用例冲突。 */
async function freePort(): Promise<number> {
  const blocker = createServer();
  await new Promise<void>((resolve) => {
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const address = blocker.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    blocker.close(() => resolve());
  });
  if (port <= 0) {
    throw new Error("无法获得空闲端口");
  }
  return port;
}

interface StreamSocket {
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  send(data: string): void;
  close(): void;
}

interface StreamClient {
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): void;
  close(): void;
}

const StreamWebSocket = (globalThis as unknown as {
  WebSocket: new (url: string) => StreamSocket;
}).WebSocket;

/** 建立真实 WS 连接并按到达顺序缓存消息。 */
function connectStream(url: string): StreamClient {
  const socket = new StreamWebSocket(url);
  const pending: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(message);
    } else {
      waiter(message);
    }
  });
  socket.addEventListener("error", () => {
    // 连接错误由等待超时体现，避免未处理的 error 事件。
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
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error("等待 WS 消息超时"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return {
    next,
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => {
      try {
        socket.close();
      } catch {
        // 已关闭的连接无需处理。
      }
    },
  };
}

/** 复制标准装配并替换时钟/资源有效配置，用于验证宿主确实使用解析后的配置。 */
function configuredAssembly(overrides: {
  readonly clock?: Readonly<Record<string, Json>>;
  readonly resources?: Readonly<Record<string, Json>>;
  readonly accessPolicy?: Readonly<Record<string, Json>>;
}): AssemblyDescriptor {
  const base = loadAssembly("local-slg-standard-v1");
  const configs: Record<string, Json> = { ...base.configs };
  const bindings = base.realms.server.bindings.map((binding) => {
    if (binding.capability === "game.clock" && overrides.clock !== undefined) {
      return { ...binding, configRef: "clock" };
    }
    if (binding.capability === "game.resources" && overrides.resources !== undefined) {
      return { ...binding, configRef: "resources" };
    }
    if (binding.capability === "platform.access-policy" && overrides.accessPolicy !== undefined) {
      return { ...binding, configRef: "access-policy" };
    }
    return binding;
  });
  if (overrides.clock !== undefined) {
    configs["clock"] = { ...(configs["clock"] as Record<string, Json>), ...overrides.clock };
  }
  if (overrides.resources !== undefined) {
    configs["resources"] = { ...overrides.resources };
  }
  if (overrides.accessPolicy !== undefined) {
    configs["access-policy"] = { ...overrides.accessPolicy };
  }
  return {
    ...base,
    assemblyId: "test-host-config-v1",
    configs,
    realms: {
      ...base.realms,
      server: { ...base.realms.server, bindings },
    },
  };
}

/** 等待条件成立；服务端异步事件（WS 关闭、计时器）没有同步信号。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("等待条件超时");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/** 读取在线分支时钟行；测试只经 StoragePort 访问。 */
function clockRow(host: RunningHost): Readonly<Record<string, StorageCell>> {
  const row = host.storage.transact((tx) => tx.branch(host.branchId).table("clock").get({}));
  if (row === null) {
    throw new Error("在线分支缺少时钟行");
  }
  return row;
}

describe("服务端宿主", () => {
  it("首次启动创建在线分支并可开局", async () => {
    const dataDir = tempDataDir();
    const host = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const health = await host.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ready" });

    const login = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "player-token" } });
    expect(login.statusCode).toBe(200);
    const session = (login.json() as { readonly sessionToken: string }).sessionToken;
    const command = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000001");
    const started = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: { authorization: `Bearer ${session}` },
      payload: command,
    });
    expect(started.statusCode).toBe(200);
    const view = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers: { authorization: `Bearer ${session}` } });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ projection: { campaign: { factionId: "human-neutral" }, clock: { worldTick: 0 } } });
    const sessionView = await host.app.inject({ method: "GET", url: "/api/v1/session", headers: { authorization: `Bearer ${session}` } });
    expect((sessionView.json() as { readonly serverAssembly: { readonly modules: unknown[] } }).serverAssembly.modules.length).toBeGreaterThan(0);
    const runRow = host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" })[0]);
    expect(runRow).toMatchObject({ mode: "live", status: "running" });

    const originalBranchId = host.branchId;
    const reset = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/reset",
      headers: { authorization: `Bearer ${session}` },
      payload: { operationId: "op-000000000001" },
    });
    expect(reset.statusCode).toBe(200);
    const resetBody = reset.json() as { readonly branchId: string };
    expect(resetBody.branchId).not.toBe(originalBranchId);
    // 重开响应只返回新在线分支；新分支时钟由宿主置为暂停并可从存档读取。
    const resetClock = host.storage.transact((tx) => tx.branch(resetBody.branchId).table("clock").get({}));
    expect(resetClock).toMatchObject({ mode: "paused", world_tick: 0 });
    // 宿主内存中的在线分支与别名同步更新。
    expect(host.branchId).toBe(resetBody.branchId);
    const runs = host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" }));
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run["status"] === "running")).toHaveLength(1);
    expect(runs.filter((run) => run["status"] === "completed")).toHaveLength(1);
    const alias = host.storage.transact((tx) => tx.rows("world_aliases").get({ alias: "online" }));
    expect(alias).toMatchObject({ branch_id: resetBody.branchId });
    const snapshots = await host.app.inject({ method: "GET", url: "/api/v1/campaign/snapshots", headers: { authorization: `Bearer ${session}` } });
    expect(snapshots.statusCode).toBe(200);
    expect((snapshots.json() as { readonly snapshots: unknown[] }).snapshots).toHaveLength(1);
  });

  it("实际宿主提供开局读取、会话与装配握手", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const unauthenticated = await host.app.inject({ method: "GET", url: "/api/v1/campaign" });
    expect(unauthenticated.statusCode).toBe(401);
    const session = await loginSession(host, "player-token");
    const headers = { authorization: `Bearer ${session}` };

    // 开局前没有 campaign，但仍返回合法结构与内容包声明的唯一开放开局。
    const before = await host.app.inject({ method: "GET", url: "/api/v1/campaign", headers });
    expect(before.statusCode).toBe(200);
    const beforeBody = campaignResponseSchema.parse(before.json());
    expect(beforeBody.campaign).toBeNull();
    expect(beforeBody.starts.map((start) => start.factionId)).toEqual(["human-neutral"]);
    expect(beforeBody.starts.find((start) => start.factionId === "human-neutral")?.contacts).toEqual([
      { agentId: "npc-wenzhao", name: "闻昭" },
      { agentId: "npc-yinuo", name: "伊诺" },
      { agentId: "npc-wenyuan", name: "温原" },
    ]);

    // 玩家握手只返回 client 装配；console 装配需要控制台角色。
    const client = await host.app.inject({ method: "GET", url: "/api/v1/session/assembly?realm=client", headers });
    expect(client.statusCode).toBe(200);
    const clientAssembly = sessionAssemblyResponseSchema.parse(client.json());
    expect(clientAssembly).toMatchObject({ realm: "client", protocolVersion: "1" });
    expect(clientAssembly.modules.length).toBeGreaterThanOrEqual(11);
    expect(clientAssembly.capabilities.map((capability) => capability.capability)).toContain(
      "client.world-view",
    );
    expect(clientAssembly.assemblyHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await host.app.inject({ method: "GET", url: "/api/v1/session/assembly?realm=console", headers })).statusCode).toBe(403);
    const sessionView = await host.app.inject({ method: "GET", url: "/api/v1/session", headers });
    expect(sessionView.json()).toMatchObject({ clientAssembly: { realm: "client" } });

    const consoleSession = await loginSession(host, "console-token");
    const consoleAssembly = await host.app.inject({
      method: "GET",
      url: "/api/v1/session/assembly?realm=console",
      headers: { authorization: `Bearer ${consoleSession}` },
    });
    expect(consoleAssembly.statusCode).toBe(200);
    expect(sessionAssemblyResponseSchema.parse(consoleAssembly.json())).toMatchObject({ realm: "console" });

    const started = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers,
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000201"),
    });
    expect(started.statusCode).toBe(200);
    const after = campaignResponseSchema.parse((await host.app.inject({ method: "GET", url: "/api/v1/campaign", headers })).json());
    expect(after.campaign).toMatchObject({ factionId: "human-neutral", factionName: "灰港公社", status: "running", startTick: 0 });
    const projection = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers });
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toMatchObject({
      projection: {
        characters: expect.arrayContaining([
          expect.objectContaining({ agentId: "human-independent", name: "岑雁" }),
          expect.objectContaining({ agentId: "npc-wenzhao", name: "闻昭" }),
        ]),
      },
    });
    expect(projection.json<{ readonly projection: { readonly characters: readonly unknown[] } }>()
      .projection.characters).toHaveLength(15);

    // 宿主启动后时钟保持暂停；玩家继续时钟后对白命令才会被受理。
    const resumed = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/resume",
      headers,
      payload: { operationId: "op-000000000001", expectedRunVersion: 0 },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ mode: "running" });

    // 真实对白经命令网关提交后，玩家可读取该会话；分页参数与当事人限制生效。
    const said = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers,
      payload: gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-wenyuan", text: "物资清单在哪里？" }, "cmd-000000000202"),
    });
    expect(said.statusCode).toBe(200);
    expect(said.json()).toMatchObject({ commandStatus: "accepted" });
    const conversation = await host.app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan", headers });
    expect(conversation.statusCode).toBe(200);
    const conversationBody = conversationResponseSchema.parse(conversation.json());
    expect(conversationBody.conversationId).toMatch(/^conv-/);
    expect(conversationBody.lines).toHaveLength(1);
    expect(conversationBody.lines[0]).toMatchObject({
      seq: 0,
      speakerId: "player-1",
      text: "物资清单在哪里？",
      channel: "face-to-face",
      worldTick: 0,
    });

    const limited = conversationResponseSchema.parse(
      (await host.app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?limit=1", headers })).json(),
    );
    expect(limited.lines).toHaveLength(1);
    const older = conversationResponseSchema.parse(
      (await host.app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?beforeSeq=1", headers })).json(),
    );
    expect(older.lines.map((line) => line.seq)).toEqual([0]);
    const beforeStart = conversationResponseSchema.parse(
      (await host.app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?beforeSeq=0", headers })).json(),
    );
    expect(beforeStart.lines).toEqual([]);
    expect((await host.app.inject({ method: "GET", url: "/api/v1/conversations/npc-unknown", headers })).statusCode).toBe(404);
    const consoleDenied = await host.app.inject({
      method: "GET",
      url: "/api/v1/conversations/npc-wenyuan",
      headers: { authorization: `Bearer ${consoleSession}` },
    });
    expect(consoleDenied.statusCode).toBe(403);
  }, 20_000);

  it("实际宿主按会话角色与 X-Active-Role 授权玩家、控制台与 WS 频道", async () => {
    const port = await freePort();
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      transportPort: port,
    });
    hosts.push(host);
    await host.listen();
    const playerSession = await loginSession(host, "player-token");
    const consoleSession = await loginSession(host, "console-token");
    const playerHeaders = { authorization: `Bearer ${playerSession}` };
    const consoleHeaders = { authorization: `Bearer ${consoleSession}` };

    // 控制台会话访问玩家接口一律 403；被拒命令不进入网关。
    for (const request of [
      { method: "GET" as const, url: "/api/v1/campaign" },
      { method: "GET" as const, url: "/api/v1/world/view" },
      { method: "GET" as const, url: "/api/v1/conversations/npc-wenyuan" },
    ]) {
      const denied = await host.app.inject({ ...request, headers: consoleHeaders });
      expect(denied.statusCode).toBe(403);
      expect(errorResponseSchema.parse(denied.json()).error.code).toBe("forbidden");
    }
    const deniedCommand = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: consoleHeaders,
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000401"),
    });
    expect(deniedCommand.statusCode).toBe(403);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("command_receipts").list())).toEqual([]);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("domain_events").list())).toEqual([]);

    // 玩家会话即使自报控制台角色也没有持有该角色；缺少请求头与非法角色同样 403。
    const playerConsole = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...playerHeaders, "x-active-role": "operator" },
    });
    expect(playerConsole.statusCode).toBe(403);
    const missingRole = await host.app.inject({ method: "GET", url: "/api/v1/console/health", headers: consoleHeaders });
    expect(missingRole.statusCode).toBe(403);
    expect(errorResponseSchema.parse(missingRole.json()).error.safeMessage).toContain("X-Active-Role");
    const invalidRole = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...consoleHeaders, "x-active-role": "admin" },
    });
    expect(invalidRole.statusCode).toBe(403);
    // 默认名册授权 operator 与 researcher；会话未持有的 evaluator 角色仍被拒绝。
    const researcherAllowed = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...consoleHeaders, "x-active-role": "researcher" },
    });
    expect(researcherAllowed.statusCode).toBe(200);
    const evaluatorDenied = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...consoleHeaders, "x-active-role": "evaluator" },
    });
    expect(evaluatorDenied.statusCode).toBe(403);
    const allowed = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...consoleHeaders, "x-active-role": "operator" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      ports: { client: 5173, server: port },
      realms: ["server", "client", "console"],
      queues: { turnsQueued: 0, turnsRunning: 0, maintenanceQueued: 0, modelQueue: 0 },
    });
    expect(allowed.json<{ readonly modules: readonly unknown[] }>().modules.length).toBeGreaterThan(0);
    const moduleCatalog = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/modules?realm=client",
      headers: { ...consoleHeaders, "x-active-role": "operator" },
    });
    expect(moduleCatalog.statusCode).toBe(200);
    expect(moduleCatalog.json()).toMatchObject({
      modules: expect.arrayContaining([
        expect.objectContaining({ moduleId: "client.world-view.standard", realm: "client" }),
      ]),
    });
    const assemblies = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/assemblies",
      headers: { ...consoleHeaders, "x-active-role": "operator" },
    });
    expect(assemblies.statusCode).toBe(200);
    expect(assemblies.json()).toMatchObject({
      assemblies: expect.arrayContaining([
        expect.objectContaining({ assemblyId: "local-slg-standard-v1", source: "repo" }),
      ]),
    });
    const assembly = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/assemblies/local-slg-standard-v1",
      headers: { ...consoleHeaders, "x-active-role": "operator" },
    });
    expect(assembly.statusCode).toBe(200);
    expect(assembly.json()).toMatchObject({
      descriptor: { assemblyId: "local-slg-standard-v1" },
      resolved: {
        client: { realm: "client" },
        console: { realm: "console" },
      },
    });
    const timeline = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/timeline",
      headers: { ...consoleHeaders, "x-active-role": "researcher" },
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toEqual({ events: [] });
    host.storage.transact((tx) => {
      const events = tx.branch(host.branchId).table("domain_events");
      for (let seq = 1; seq <= 31; seq += 1) {
        events.put({
          world_seq: seq,
          event_id: `evt-${String(seq).padStart(12, "0")}`,
          world_tick: 0,
          type: seq === 31 ? "LateMatched" : "EarlierIgnored",
          schema_version: 1,
          principal_id: "player-1",
          causation_ids_json: [],
          correlation_id: `corr-${String(seq).padStart(12, "0")}`,
          audience_json: [{ kind: "public" }],
          payload_json: {
            agentId: seq === 31 ? "human-independent" : "human-neutral",
            nodeId: seq === 31 ? "node-gate" : "node-harbor",
          },
          committed_at: "2026-01-01T00:00:00.000Z",
        });
      }
    });
    const lateTimeline = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/timeline?fromSeq=0&limit=10&order=desc&types=LateMatched&agentId=human-independent&nodeId=node-gate",
      headers: { ...consoleHeaders, "x-active-role": "researcher" },
    });
    expect(lateTimeline.statusCode).toBe(200);
    expect(lateTimeline.json()).toMatchObject({
      events: [{ type: "LateMatched", worldSeq: 31 }],
    });
    const tooManyTimelineTypes = Array.from({ length: 21 }, (_, index) => `event.${index}`).join(",");
    const invalidTimeline = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/timeline?types=${encodeURIComponent(tooManyTimelineTypes)}`,
      headers: { ...consoleHeaders, "x-active-role": "researcher" },
    });
    expect(invalidTimeline.statusCode).toBe(400);
    const invalidOrder = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/timeline?order=sideways",
      headers: { ...consoleHeaders, "x-active-role": "researcher" },
    });
    expect(invalidOrder.statusCode).toBe(400);
    const agents = await host.app.inject({
      method: "GET",
      url: `/api/v1/console/agents?branchId=${host.branchId}`,
      headers: { ...consoleHeaders, "x-active-role": "researcher" },
    });
    expect(agents.statusCode).toBe(200);
    expect(agents.json()).toEqual({ agents: [] });
    const operatorTimeline = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/timeline",
      headers: { ...consoleHeaders, "x-active-role": "operator" },
    });
    expect(operatorTimeline.statusCode).toBe(403);
    expect(host.storage.transact((tx) => tx.rows("trace_spans").count())).toBeGreaterThan(0);

    // WS：玩家 hello 只含 player 频道，控制台角色也不能订阅玩家频道。
    const playerTicket = await ticketFor(host, playerSession);
    const playerClient = connectStream(
      `ws://127.0.0.1:${port}/api/v1/streams?ticket=${encodeURIComponent(playerTicket)}`,
    );
    try {
      expect(await playerClient.next()).toMatchObject({ type: "hello", principalId: "player-1", channels: ["player"] });
      playerClient.send({ type: "subscribe", channel: "console.health", fromStreamSeq: null });
      expect(await playerClient.next()).toMatchObject({ type: "error", code: "forbidden" });
      host.app.notifyWorldChanged();
      // 被拒订阅没有加入推送集合，世界变化不推送。
      await expect(playerClient.next(100)).rejects.toThrow("等待 WS 消息超时");
    } finally {
      playerClient.close();
    }

    const consoleTicket = await ticketFor(host, consoleSession);
    const consoleClient = connectStream(
      `ws://127.0.0.1:${port}/api/v1/streams?ticket=${encodeURIComponent(consoleTicket)}`,
    );
    try {
      expect(await consoleClient.next()).toMatchObject({
        type: "hello",
        channels: ["console.health", "console.timeline", "console.turns"],
      });
      consoleClient.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
      expect(await consoleClient.next()).toMatchObject({ type: "error", code: "forbidden" });
      consoleClient.send({ type: "subscribe", channel: "console.health", fromStreamSeq: null });
      const healthSnapshot = await consoleClient.next();
      expect(healthSnapshot).toMatchObject({
        type: "snapshot",
        channel: "console.health",
        data: { ports: { client: 5173, server: port } },
      });
      expect(healthSnapshot).toHaveProperty("projectionVersion", 0);
      consoleClient.send({ type: "subscribe", channel: "console.timeline", fromStreamSeq: null });
      const initialTimelineSnapshot = await consoleClient.next();
      expect(initialTimelineSnapshot).toMatchObject({
        type: "snapshot",
        channel: "console.timeline",
      });
      expect(initialTimelineSnapshot).toHaveProperty("projectionVersion", 0);
      host.app.notifyWorldChanged();
      let timelineSnapshot: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const message = await consoleClient.next();
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { readonly channel?: unknown }).channel === "console.timeline"
        ) {
          timelineSnapshot = message;
          break;
        }
      }
      expect(timelineSnapshot).toMatchObject({
        type: "snapshot",
        channel: "console.timeline",
      });
    } finally {
      consoleClient.close();
    }
  }, 30_000);

  it("生产宿主使用默认 fencing 拒绝无 turn 的 Agent 命令", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const clockBefore = host.storage.transact((tx) => tx.branch(host.branchId).table("clock").get({}));
    const auth: AuthContext = {
      principalId: "npc-wenyuan",
      kind: "agent",
      roles: ["agent"],
      worldId: host.worldId,
      branchId: host.branchId,
      actingAsAgentId: null,
      controllerEpoch: null,
      turnLeaseEpoch: null,
      turnId: null,
    };
    const receipt = host.authority.commands.execute(
      auth,
      gameCommandEnvelope("information.share", {}, "cmd-000000000402"),
    );
    // 无 controllerEpoch 与 turn 租约的命令在网关内被 fencing 拒绝，不产生领域事件。
    expect(receipt.commandStatus).toBe("rejected");
    expect(receipt.reasonCode).toBe("stale-controller");
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("domain_events").list())).toEqual([]);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("aggregate_state").list())).toEqual([]);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("clock").get({}))).toEqual(clockBefore);
  });

  it("装配中的 access-policy 配置决定玩家命令与控制台角色裁决", async () => {
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      assembly: configuredAssembly({
        accessPolicy: { playerCommands: ["dialogue.say"], consoleRoles: ["researcher"] },
      }),
    });
    hosts.push(host);
    const playerSession = await loginSession(host, "player-token");
    const denied = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: { authorization: `Bearer ${playerSession}` },
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000403"),
    });
    expect(denied.statusCode).toBe(403);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("command_receipts").list())).toEqual([]);
    expect(host.storage.transact((tx) => tx.branch(host.branchId).table("domain_events").list())).toEqual([]);

    const consoleSession = await loginSession(host, "console-token");
    const operatorDenied = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { authorization: `Bearer ${consoleSession}`, "x-active-role": "operator" },
    });
    expect(operatorDenied.statusCode).toBe(403);
    const researcherAllowed = await host.app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { authorization: `Bearer ${consoleSession}`, "x-active-role": "researcher" },
    });
    expect(researcherAllowed.statusCode).toBe(200);
  });

  it("首次启动生成 seed 与 manifest，重启沿用同一 run、seed 与装配", async () => {
    const dataDir = tempDataDir();
    const first = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    let runId = "";
    let manifestHash: StorageCell | undefined;
    let branchId = "";
    try {
      const run = liveRun(first);
      const spec = run["run_spec_json"] as {
        readonly seed: string;
        readonly moduleAssemblyRef: string;
        readonly rosterRef: string;
        readonly modelLayoutRef: string;
      };
      expect(spec.seed).toMatch(/^[0-9a-f]{32}$/);
      expect(spec.seed).not.toBe("generated");
      expect(spec.moduleAssemblyRef).toBe("local-slg-standard-v1");
      expect(spec.rosterRef).toBe("standard-15");
      expect(spec.modelLayoutRef).toBe("shared-model-layout-v1");
      const manifest = run["manifest_json"] as {
        readonly seed: string;
        readonly selection: { readonly moduleAssemblyRef: string; readonly rosterRef: string };
        readonly content: { readonly packId: string; readonly contentVersion: string };
        readonly agentSlots: StorageCell;
      };
      expect(manifest.seed).toBe(spec.seed);
      expect(manifest.selection).toMatchObject({ moduleAssemblyRef: "local-slg-standard-v1", rosterRef: "standard-15" });
      expect(manifest.content).toEqual({ packId: "earth-2964-v1", contentVersion: "0.2.0" });
      expect(manifest.agentSlots).toBeNull();
      expect(run["manifest_hash"]).toMatch(/^[0-9a-f]{64}$/);
      runId = String(run["run_id"]);
      manifestHash = run["manifest_hash"];
      branchId = first.branchId;
      const world = first.storage.transact((tx) => tx.rows("worlds").get({ world_id: first.worldId }));
      expect(world).toMatchObject({ pack_id: "earth-2964-v1", content_version: "0.2.0" });
    } finally {
      await first.close();
    }

    const second = await startHost({
      dataDir,
      playerToken: "player-token",
      consoleToken: "console-token",
      assemblyRef: "local-slg-escalating-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
    });
    hosts.push(second);
    expect(second.branchId).toBe(branchId);
    const resumed = second.storage.transact((tx) => tx.rows("runs").get({ run_id: runId }));
    expect(resumed).not.toBeNull();
    const resumedSpec = resumed?.["run_spec_json"] as {
      readonly seed: string;
      readonly moduleAssemblyRef: string;
      readonly rosterRef: string;
      readonly modelLayoutRef: string;
    };
    expect(resumedSpec.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(resumedSpec.moduleAssemblyRef).toBe("local-slg-standard-v1");
    expect(resumedSpec.rosterRef).toBe("standard-15");
    expect(resumedSpec.modelLayoutRef).toBe("shared-model-layout-v1");
    expect(resumed?.["manifest_hash"]).toBe(manifestHash);
    expect(second.storage.transact((tx) => tx.rows("runs").list({ mode: "live" }))).toHaveLength(1);
    const session = await loginSession(second, "player-token");
    const sessionView = await second.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { authorization: `Bearer ${session}` },
    });
    const modules = (sessionView.json() as {
      readonly serverAssembly: { readonly modules: readonly { readonly moduleId: string }[] };
    }).serverAssembly.modules;
    expect(modules.some((module) => module.moduleId === "game.scenario.watergate")).toBe(true);
    expect(modules.some((module) => module.moduleId === "game.scenario.watergate-escalating")).toBe(false);
  });

  it("首次启动选择升级装配时 RunSpec 与 manifest 记录实际引用", async () => {
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      assemblyRef: "local-slg-escalating-v1",
    });
    hosts.push(host);
    const run = liveRun(host);
    const spec = run["run_spec_json"] as { readonly moduleAssemblyRef: string };
    expect(spec.moduleAssemblyRef).toBe("local-slg-escalating-v1");
    const manifest = run["manifest_json"] as unknown as {
      readonly selection: { readonly moduleAssemblyRef: string };
      readonly assembly: {
        readonly assemblyId: string;
        readonly modules: readonly { readonly moduleId: string }[];
      };
    };
    expect(manifest.selection.moduleAssemblyRef).toBe("local-slg-escalating-v1");
    expect(manifest.assembly.assemblyId).toBe("local-slg-escalating-v1");
    expect(manifest.assembly.modules.some((module) => module.moduleId === "game.scenario.watergate-escalating")).toBe(true);
    expect(host.storage.transact((tx) => tx.rows("runs").list({ mode: "live" }))).toHaveLength(1);
  });

  it("内容包 contentVersion 与冻结 manifest 不一致时拒绝启动并提示重置开发数据", async () => {
    const options = { dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" };
    const first = await startHost(options);
    try {
      const run = liveRun(first);
      const manifest = run["manifest_json"] as { readonly [key: string]: StorageCell };
      const content = manifest["content"] as { readonly [key: string]: StorageCell };
      first.storage.transact((tx) => {
        tx.rows("runs").put({
          ...run,
          manifest_json: { ...manifest, content: { ...content, contentVersion: "9.9.9" } },
        });
      });
    } finally {
      await first.close();
    }

    await expect(startHost(options)).rejects.toThrow(
      /contentVersion 不一致.*9\.9\.9.*0\.2\.0.*删除 NPC_DATA_DIR 对应的开发数据目录/,
    );
  });

  it("恢复切换在线别名与投影，重启后仍选中后继分支与 run", async () => {
    const dataDir = tempDataDir();
    const port = await freePort();
    const host = await startHost({
      dataDir,
      playerToken: "player-token",
      consoleToken: "console-token",
      transportPort: port,
    });
    let successorBranchId = "";
    let successorRunId = "";
    let sourceBranchId = "";
    let sourceRunId = "";
    try {
      await host.listen();
      const session = await loginSession(host, "player-token");
      const headers = { authorization: `Bearer ${session}` };
      const started = await host.app.inject({
        method: "POST",
        url: "/api/v1/commands",
        headers,
        payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000101"),
      });
      expect(started.statusCode).toBe(200);
      const source = onlineEntry(host);
      sourceBranchId = source.branchId;
      sourceRunId = source.runId;

      // 在 tick 5 存档，随后把旧分支时钟推到 tick 7，用于区分恢复后的投影来源。
      setBranchClock(host, sourceBranchId, 5);
      const snapshot = await host.app.inject({
        method: "POST",
        url: "/api/v1/campaign/snapshots",
        headers,
        payload: { operationId: "op-000000000104", label: "恢复点" },
      });
      expect(snapshot.statusCode).toBe(200);
      const snapshotId = (snapshot.json() as { readonly snapshotId: string }).snapshotId;
      // 存档会先排空到期 job；以快照后的源分支为准比较后继分支的待办 job。
      const sourceJobs = host.storage.transact((tx) => tx.branch(sourceBranchId).table("jobs").list());
      expect(sourceJobs.some((job) => job["status"] === "scheduled")).toBe(true);
      setBranchClock(host, sourceBranchId, 7);

      const ticket = await ticketFor(host, session);
      const client = connectStream(`ws://127.0.0.1:${port}/api/v1/streams?ticket=${encodeURIComponent(ticket)}`);
      try {
        expect(await client.next()).toMatchObject({ type: "hello", channels: ["player"] });
        client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
        expect(await client.next()).toMatchObject({
          type: "snapshot",
          channel: "player",
          data: { clock: { worldTick: 7, mode: "paused" } },
        });

        const restored = await host.app.inject({
          method: "POST",
          url: "/api/v1/campaign/restore",
          headers,
          payload: { operationId: "op-000000000105", snapshotId },
        });
        expect(restored.statusCode).toBe(200);
        const restoredBody = restored.json() as { readonly branchId: string; readonly clock: { readonly mode: string; readonly worldTick: number } };
        successorBranchId = restoredBody.branchId;
        expect(successorBranchId).not.toBe(sourceBranchId);
        expect(restoredBody.clock).toMatchObject({ worldTick: 5, mode: "paused" });
        // 宿主内存中的在线分支随提交结果更新。
        expect(host.branchId).toBe(successorBranchId);

        // 传输层在切换后立即推送后继分支的完整投影快照。
        expect(await client.next()).toMatchObject({
          type: "snapshot",
          channel: "player",
          data: { clock: { worldTick: 5, mode: "paused" } },
        });
      } finally {
        client.close();
      }

      const alias = host.storage.transact((tx) => tx.rows("world_aliases").get({ alias: "online" }));
      expect(alias).toMatchObject({ branch_id: successorBranchId });
      const frozenBranchId = String(
        host.storage.transact((tx) => tx.rows("snapshots").get({ snapshot_id: snapshotId }))?.["frozen_branch_id"],
      );
      const successorBranch = host.storage.transact((tx) => tx.rows("branches").get({ branch_id: successorBranchId }));
      expect(successorBranch).toMatchObject({ kind: "online", status: "active", parent_branch_id: frozenBranchId });
      successorRunId = String(successorBranch?.["run_id"]);
      expect(successorRunId).not.toBe(sourceRunId);
      const successorRun = host.storage.transact((tx) => tx.rows("runs").get({ run_id: successorRunId }));
      expect(successorRun).toMatchObject({ branch_id: successorBranchId, mode: "live", status: "running" });
      expect(successorRun?.["run_spec_json"]).toEqual(source.run["run_spec_json"]);
      expect((successorRun?.["run_spec_json"] as { readonly seed: string }).seed).toBe(
        (source.run["run_spec_json"] as { readonly seed: string }).seed,
      );
      expect(successorRun?.["manifest_json"]).toEqual(source.run["manifest_json"]);
      expect(successorRun?.["manifest_hash"]).toBe(source.run["manifest_hash"]);

      const previousRun = host.storage.transact((tx) => tx.rows("runs").get({ run_id: sourceRunId }));
      expect(previousRun).toMatchObject({ branch_id: sourceBranchId, status: "completed" });
      expect(previousRun?.["ended_at"]).not.toBeNull();
      const previousBranch = host.storage.transact((tx) => tx.rows("branches").get({ branch_id: sourceBranchId }));
      expect(previousBranch).toMatchObject({ kind: "online", status: "archived" });

      const successorClock = host.storage.transact((tx) => tx.branch(successorBranchId).table("clock").get({}));
      expect(successorClock).toMatchObject({ world_tick: 5, mode: "paused" });
      const successorJobs = host.storage.transact((tx) => tx.branch(successorBranchId).table("jobs").list());
      expect(successorJobs.map((job) => job["job_id"]).sort()).toEqual(sourceJobs.map((job) => job["job_id"]).sort());
      expect(successorJobs.filter((job) => job["status"] === "scheduled")).toHaveLength(
        sourceJobs.filter((job) => job["status"] === "scheduled").length,
      );

      const snapshots = await host.app.inject({
        method: "GET",
        url: "/api/v1/campaign/snapshots",
        headers,
      });
      expect(snapshots.statusCode).toBe(200);
      expect((snapshots.json() as { readonly snapshots: readonly { readonly snapshotId: string }[] }).snapshots).toHaveLength(1);
      const sessionView = await host.app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers,
      });
      expect(sessionView.json()).toMatchObject({ branchId: successorBranchId });
    } finally {
      await host.close();
    }

    const second = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(second);
    expect(second.branchId).toBe(successorBranchId);
    const resumed = onlineEntry(second);
    expect(resumed.branchId).toBe(successorBranchId);
    expect(resumed.runId).toBe(successorRunId);
    expect(resumed.run).toMatchObject({ branch_id: successorBranchId, status: "running" });
    const session = await loginSession(second, "player-token");
    const view = await second.app.inject({
      method: "GET",
      url: "/api/v1/world/view",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      projection: { campaign: { factionId: "human-neutral" }, clock: { worldTick: 5, mode: "paused" } },
    });
  }, 30_000);

  it("恢复 dry-run 发现内容版本不兼容时不切换别名", async () => {
    const host = await startHost({ dataDir: tempDataDir(), playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(host);
    const session = await loginSession(host, "player-token");
    const headers = { authorization: `Bearer ${session}` };
    const started = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers,
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000102"),
    });
    expect(started.statusCode).toBe(200);
    const snapshot = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/snapshots",
      headers,
      payload: { operationId: "op-000000000106", label: "旧版本恢复点" },
    });
    expect(snapshot.statusCode).toBe(200);
    const snapshotId = (snapshot.json() as { readonly snapshotId: string }).snapshotId;

    const before = host.storage.transact((tx) => ({
      branches: tx.rows("branches").list().map((row) => String(row["branch_id"])).sort(),
      runs: tx.rows("runs").list().map((row) => String(row["run_id"])).sort(),
      alias: String(tx.rows("world_aliases").get({ alias: "online" })?.["branch_id"]),
      snapshots: tx.rows("snapshots").list().map((row) => String(row["snapshot_id"])).sort(),
    }));
    const source = onlineEntry(host);
    host.storage.transact((tx) => {
      const manifest = source.run["manifest_json"] as { readonly [key: string]: StorageCell };
      const content = manifest["content"] as { readonly [key: string]: StorageCell };
      tx.rows("runs").put({
        ...source.run,
        manifest_json: { ...manifest, content: { ...content, contentVersion: "9.9.9" } },
      });
    });

    const restored = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/restore",
      headers,
      payload: { operationId: "op-000000000107", snapshotId },
    });
    expect(restored.statusCode).toBe(500);
    const after = host.storage.transact((tx) => ({
      branches: tx.rows("branches").list().map((row) => String(row["branch_id"])).sort(),
      runs: tx.rows("runs").list().map((row) => String(row["run_id"])).sort(),
      alias: String(tx.rows("world_aliases").get({ alias: "online" })?.["branch_id"]),
      snapshots: tx.rows("snapshots").list().map((row) => String(row["snapshot_id"])).sort(),
    }));
    expect(after).toEqual(before);
    expect(host.branchId).toBe(before.alias);
  });

  it("重开后重启仍选中重开后的在线分支", async () => {
    const dataDir = tempDataDir();
    const first = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    let resetBranchId = "";
    let resetRunId = "";
    let previousBranchId = "";
    let previousRunId = "";
    try {
      const session = await loginSession(first, "player-token");
      const headers = { authorization: `Bearer ${session}` };
      const started = await first.app.inject({
        method: "POST",
        url: "/api/v1/commands",
        headers,
        payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000103"),
      });
      expect(started.statusCode).toBe(200);
      const previous = onlineEntry(first);
      previousBranchId = previous.branchId;
      previousRunId = previous.runId;
      const reset = await first.app.inject({
        method: "POST",
        url: "/api/v1/campaign/reset",
        headers,
        payload: { operationId: "op-000000000103" },
      });
      expect(reset.statusCode).toBe(200);
      resetBranchId = (reset.json() as { readonly branchId: string }).branchId;
      expect(resetBranchId).not.toBe(previousBranchId);
      const resetBranch = first.storage.transact((tx) => tx.rows("branches").get({ branch_id: resetBranchId }));
      expect(resetBranch).toMatchObject({ kind: "online", status: "active", parent_branch_id: previousBranchId });
      resetRunId = String(resetBranch?.["run_id"]);
      expect(resetRunId).not.toBe(previousRunId);
    } finally {
      await first.close();
    }

    const second = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(second);
    // 审查实测缺陷：重开后重启曾选中归档的旧在线分支。
    expect(second.branchId).toBe(resetBranchId);
    const alias = second.storage.transact((tx) => tx.rows("world_aliases").get({ alias: "online" }));
    expect(alias).toMatchObject({ branch_id: resetBranchId });
    const resetBranch = second.storage.transact((tx) => tx.rows("branches").get({ branch_id: resetBranchId }));
    expect(resetBranch).toMatchObject({ kind: "online", status: "active", run_id: resetRunId });
    const resetRun = second.storage.transact((tx) => tx.rows("runs").get({ run_id: resetRunId }));
    expect(resetRun).toMatchObject({ branch_id: resetBranchId, mode: "live", status: "running" });
    const previousBranch = second.storage.transact((tx) => tx.rows("branches").get({ branch_id: previousBranchId }));
    expect(previousBranch).toMatchObject({ status: "archived" });
    const previousRun = second.storage.transact((tx) => tx.rows("runs").get({ run_id: previousRunId }));
    expect(previousRun).toMatchObject({ status: "completed" });
    const session = await loginSession(second, "player-token");
    const sessionView = await second.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(sessionView.json()).toMatchObject({ branchId: resetBranchId });
    const view = await second.app.inject({
      method: "GET",
      url: "/api/v1/world/view",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ projection: { campaign: null, clock: { worldTick: 0, mode: "paused" } } });
  }, 30_000);

  it("在线别名指向缺失分支、run 缺失或 manifest 不一致时拒绝启动", async () => {
    const dataDir = tempDataDir();
    const first = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    const online = onlineEntry(first);
    try {
      // manifest 与 RunSpec 不一致：不得静默重建，也不得改选其他分支。
      const manifest = online.run["manifest_json"] as { readonly [key: string]: StorageCell };
      first.storage.transact((tx) => {
        tx.rows("runs").put({
          ...online.run,
          manifest_json: { ...manifest, seed: "f".repeat(32) },
        });
      });
      await expect(startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" }))
        .rejects.toThrow(/seed 与 RunSpec 不一致/);
    } finally {
      await first.close();
    }

    const databasePath = join(dataDir, "ai-npc.db");
    // 运行级 runs 行缺失：别名分支上的 run 不存在。
    {
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare("DELETE FROM runs WHERE run_id = ?").run(online.runId);
      } finally {
        database.close();
      }
    }
    await expect(startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" }))
      .rejects.toThrow(/绑定的 run .* 不存在/);

    // 在线别名指向缺失分支：外键校验关闭后构造不一致的部署数据。
    {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec("PRAGMA foreign_keys = OFF");
        database.prepare("UPDATE world_aliases SET branch_id = ? WHERE alias = 'online'").run("br-missing");
      } finally {
        database.close();
      }
    }
    await expect(startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" }))
      .rejects.toThrow(/在线别名指向的分支 br-missing 不存在/);
  }, 30_000);

  it("未知装配在打开存储前失败", async () => {
    const dataDir = tempDataDir();
    await expect(startHost({ dataDir, playerToken: "test-player", consoleToken: "test-console", assemblyRef: "missing-assembly" })).rejects.toThrow("未知 server 装配");
    expect(existsSync(join(dataDir, "ai-npc.db"))).toBe(false);
  });

  it("玩家与控制台令牌相同时拒绝启动且不打开存储", async () => {
    const dataDir = tempDataDir();
    await expect(startHost({ dataDir, playerToken: "same-token", consoleToken: "same-token" }))
      .rejects.toThrow("登录令牌重复");
    expect(existsSync(join(dataDir, "ai-npc.db"))).toBe(false);
  });

  it("单角色令牌只发放对应控制台角色", async () => {
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      operatorToken: "operator-token",
      researcherToken: "researcher-token",
      evaluatorToken: "evaluator-token",
    });
    hosts.push(host);
    const loginAs = async (token: string) => {
      const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token } });
      expect(response.statusCode).toBe(200);
      return response.json() as { readonly principalId: string; readonly roles: readonly string[] };
    };
    expect(await loginAs("console-token")).toMatchObject({ principalId: "console-admin", roles: ["operator", "researcher", "evaluator"] });
    expect(await loginAs("operator-token")).toMatchObject({ principalId: "console-operator", roles: ["operator"] });
    expect(await loginAs("researcher-token")).toMatchObject({ principalId: "console-researcher", roles: ["researcher"] });
    expect(await loginAs("evaluator-token")).toMatchObject({ principalId: "console-evaluator", roles: ["evaluator"] });
    const unknown = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "unknown-token" } });
    expect(unknown.statusCode).toBe(401);
  }, 20_000);

  it("监听端口被占用时 listen 失败", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => { blocker.listen(0, "127.0.0.1", () => resolve()); });
    const address = blocker.address();
    try {
      expect(typeof address).toBe("object");
      const port = typeof address === "object" && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      const host = await startHost({
        dataDir: tempDataDir(),
        playerToken: "player-token",
        consoleToken: "console-token",
        transportPort: port,
      });
      hosts.push(host);
      await expect(host.listen()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => resolve()); });
    }
  }, 30_000);

  it("全部玩家断线超过阈值后自动暂停且不补算，重连取消计时并写审计", async () => {
    const port = await freePort();
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      transportPort: port,
      assembly: configuredAssembly({ clock: { secondsPerTick: 1, autoPauseAfterDisconnectMs: 600 } }),
    });
    hosts.push(host);
    await host.listen();
    const session = await loginSession(host, "player-token");
    const mode = (): string => String(clockRow(host)["mode"]);
    const tick = (): number => Number(clockRow(host)["world_tick"]);

    const first = connectStream(`ws://127.0.0.1:${port}/api/v1/streams?ticket=${encodeURIComponent(await ticketFor(host, session))}`);
    expect(await first.next()).toMatchObject({ type: "hello" });
    const headers = { authorization: `Bearer ${session}` };
    const resumed = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/resume",
      headers,
      payload: { operationId: "op-000000000901", expectedRunVersion: Number(clockRow(host)["run_version"]) },
    });
    expect(resumed.statusCode).toBe(200);
    await waitFor(() => mode() === "running");

    // 断线后计时开始；阈值内重连取消计时，时钟继续运行。
    first.close();
    await waitFor(() => host.app.streamStats().connections === 0);
    const second = connectStream(`ws://127.0.0.1:${port}/api/v1/streams?ticket=${encodeURIComponent(await ticketFor(host, session))}`);
    expect(await second.next()).toMatchObject({ type: "hello" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    expect(mode()).toBe("running");

    // 再次断线并超过阈值：自动暂停，之后 tick 不再推进。
    second.close();
    await waitFor(() => mode() === "paused", 3000);
    const pausedTick = tick();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1200);
    });
    expect(tick()).toBe(pausedTick);

    const audit = host.storage.transact((tx) =>
      tx.all(
        "SELECT type, payload_json FROM lifecycle_events WHERE branch_id = ? AND type = 'ClockAutoPaused' ORDER BY seq",
        [host.branchId],
      ),
    );
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0]?.["payload_json"]))).toMatchObject({
      reason: "players-disconnected",
      afterMs: 600,
    });
  }, 30_000);

  it("逆序释放时单步抛错仍继续其余步骤并汇总错误", async () => {
    const order: string[] = [];
    await expect(
      disposeInReverse([
        { label: "存储", dispose: async () => { order.push("storage"); } },
        {
          label: "已启动模块",
          dispose: async () => {
            order.push("modules");
            throw new Error("模块关闭失败");
          },
        },
        { label: "传输", dispose: async () => { order.push("transport"); } },
      ]),
    ).rejects.toThrow(/模块关闭失败/);
    expect(order).toEqual(["transport", "modules", "storage"]);
  });

  it("关闭时某一步抛错仍释放其余实例、清理定时器并可重新绑定端口", async () => {
    const port = await freePort();
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      transportPort: port,
    });
    await host.listen();
    const session = await loginSession(host, "player-token");
    // 恢复时钟并确保 worker 定时器已安排；关闭后必须清除。
    const resumed = await host.app.inject({
      method: "POST",
      url: "/api/v1/campaign/resume",
      headers: { authorization: `Bearer ${session}` },
      payload: { operationId: "op-000000000902", expectedRunVersion: Number(clockRow(host)["run_version"]) },
    });
    expect(resumed.statusCode).toBe(200);

    const originalClose = host.transport.close.bind(host.transport);
    const closeSpy = vi.spyOn(host.transport, "close").mockImplementation(async (app) => {
      await originalClose(app);
      throw new Error("注入关闭失败");
    });
    try {
      await expect(host.close()).rejects.toThrow(/注入关闭失败/);
    } finally {
      closeSpy.mockRestore();
    }
    // 存储已关闭，继续访问会失败。
    expect(() => host.storage.transact((tx) => tx.rows("branches").list())).toThrow();

    // 监听端口已释放，可以重新绑定。
    const rebind = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        rebind.once("error", reject);
        rebind.listen(port, "127.0.0.1", () => resolve());
      });
    } finally {
      await new Promise<void>((resolve) => {
        rebind.close(() => resolve());
      });
    }
  }, 30_000);

  it("启动中途失败时逆序释放已创建的存储与模块，并可重试启动", async () => {
    const dataDir = tempDataDir();
    const created: string[] = [];
    const disposed: string[] = [];
    const definitions: ModuleDefinition[] = serverModuleDefinitions.map((definition): ModuleDefinition => {
      if (definition.id === transportModuleDefinition.id) {
        return {
          ...definition,
          create: async () => {
            throw new Error("注入传输启动失败");
          },
        };
      }
      const label = definition.id === storageModuleDefinition.id ? "storage" : definition.id;
      return {
        ...definition,
        create: async (input) => {
          created.push(label);
          const instance = await definition.create(input);
          return {
            ...instance,
            dispose: async () => {
              disposed.push(label);
              await instance.dispose();
            },
          };
        },
      };
    });

    await expect(
      startHost({
        dataDir,
        playerToken: "player-token",
        consoleToken: "console-token",
        moduleDefinitions: definitions,
      }),
    ).rejects.toThrow("注入传输启动失败");
    // 存储最先创建、最后释放；其余已创建实例按创建逆序释放。
    expect(created[0]).toBe("storage");
    expect(disposed).toEqual([...created].reverse());

    // 残留定时器或未关闭的存储会阻塞重试；使用真实定义在同一目录重新启动。
    const retried = await startHost({ dataDir, playerToken: "player-token", consoleToken: "console-token" });
    hosts.push(retried);
  }, 30_000);

  it("测试主装配可启动并提供健康状态", async () => {
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      assemblyRef: "local-slg-test-v1",
    });
    hosts.push(host);
    const health = await host.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ready" });
    const run = liveRun(host);
    expect((run["run_spec_json"] as { readonly moduleAssemblyRef: string }).moduleAssemblyRef).toBe(
      "local-slg-test-v1",
    );
  }, 20_000);

  it("按解析计划应用时钟秒数与资源阈值配置", async () => {
    const host = await startHost({
      dataDir: tempDataDir(),
      playerToken: "player-token",
      consoleToken: "console-token",
      assembly: configuredAssembly({
        clock: { secondsPerTick: 7 },
        resources: { scarceRatio: 0.9, surplusRatio: 1.2 },
      }),
    });
    hosts.push(host);
    const clockRow = host.storage.transact((tx) => tx.branch(host.branchId).table("clock").get({}));
    expect(clockRow?.["seconds_per_tick"]).toBe(7);

    const session = await loginSession(host, "player-token");
    const headers = { authorization: `Bearer ${session}` };
    const started = await host.app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers,
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, "cmd-000000000301"),
    });
    expect(started.statusCode).toBe(200);
    // 供给 50/60=0.83：默认阈值下为 adequate，装配阈值 0.9 下应为 scarce。
    host.storage.transact((tx) => {
      const table = tx.branch(host.branchId).table("aggregate_state");
      const row = table.get({ aggregate_type: "stockpile", aggregate_id: "sp-commons" });
      if (row === null) {
        throw new Error("缺少 sp-commons 库存");
      }
      const state = row["state_json"] as { readonly amount: { readonly supply: number } };
      table.put({ ...row, state_json: { ...state, amount: { ...state.amount, supply: 50 } } });
    });
    const view = await host.app.inject({ method: "GET", url: "/api/v1/world/view", headers });
    expect(view.statusCode).toBe(200);
    const projection = (view.json() as {
      readonly projection: { readonly stockpiles: readonly { stockpileId: string; supplyLevel: string }[] };
    }).projection;
    expect(projection.stockpiles.find((stockpile) => stockpile.stockpileId === "sp-commons")?.supplyLevel).toBe(
      "scarce",
    );
  }, 20_000);

  it("缺失依赖、重复绑定、错误 realm 与非法配置都在打开存储前失败", async () => {
    const base = loadAssembly("local-slg-standard-v1");
    const serverOf = (bindings: AssemblyDescriptor["realms"]["server"]["bindings"], agentSlots?: AssemblyDescriptor["realms"]["server"]["agentSlots"]): AssemblyDescriptor => ({
      ...base,
      realms: {
        ...base.realms,
        server: { bindings, ...(agentSlots === undefined ? {} : { agentSlots }) },
      },
    });

    const missingDependency = serverOf(base.realms.server.bindings.filter((binding) => binding.capability !== "game.clock"));
    const missingDir = tempDataDir();
    await expect(startHost({ dataDir: missingDir, playerToken: "p", consoleToken: "c", assembly: missingDependency }))
      .rejects.toThrow(/game\.clock/);
    expect(existsSync(join(missingDir, "ai-npc.db"))).toBe(false);

    const duplicateBinding = serverOf([
      ...base.realms.server.bindings,
      { capability: capabilityIdSchema.parse("game.clock"), moduleId: "game.clock.controlled", configRef: "clock" },
    ]);
    const duplicateDir = tempDataDir();
    await expect(startHost({ dataDir: duplicateDir, playerToken: "p", consoleToken: "c", assembly: duplicateBinding }))
      .rejects.toThrow(/重复绑定/);
    expect(existsSync(join(duplicateDir, "ai-npc.db"))).toBe(false);

    const wrongRealm = serverOf([
      ...base.realms.server.bindings,
      { capability: capabilityIdSchema.parse("client.hud"), moduleId: "client.hud.standard", configRef: null },
    ]);
    const clientModule = defineModule({
      id: "client.hud.standard",
      realm: "client",
      kind: "service",
      version: "1.0.0",
      apiVersion: "1",
      instanceScope: "session",
      provides: [
        { capability: capabilityIdSchema.parse("client.hud"), cardinality: "exactly-one", instanceScope: "session" },
      ],
      requires: [],
      requiresRemote: [],
      configSchema: clockConfigSchema,
      stateSchemaVersion: null,
      migrationPaths: [],
      create: async () => {
        throw new Error("错误 realm 的模块不应被创建");
      },
    });
    const realmDir = tempDataDir();
    await expect(startHost({
      dataDir: realmDir,
      playerToken: "p",
      consoleToken: "c",
      assembly: wrongRealm,
      moduleDefinitions: [...serverModuleDefinitions, clientModule],
    })).rejects.toThrow(/realm/);
    expect(existsSync(join(realmDir, "ai-npc.db"))).toBe(false);

    const invalidConfig = configuredAssembly({ clock: { secondsPerTick: -1 } });
    const configDir = tempDataDir();
    await expect(startHost({ dataDir: configDir, playerToken: "p", consoleToken: "c", assembly: invalidConfig }))
      .rejects.toThrow(/配置校验失败/);
    expect(existsSync(join(configDir, "ai-npc.db"))).toBe(false);
  }, 30_000);
});
