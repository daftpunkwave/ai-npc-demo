/**
 * 验证服务端 Fastify 应用的登录、会话、装配握手、玩家读接口、命令、回执、世界视图与访问控制。
 * 依赖真实 authority/存储与注入的投影/时钟/存档回调；WS 用例在真实监听端口上连接并验证订阅、重放、撤销、增量字段与后台对象清理。
 * 禁止用静态回执替代命令网关，也不在用例间复用连接或服务器。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DomainError,
  campaignResponseSchema,
  commandReceiptSchema,
  conversationResponseSchema,
  errorResponseSchema,
  healthResponseSchema,
  playerProjectionSchema,
  protocolVersion,
  sessionAssemblyResponseSchema,
  sessionDescriptorSchema,
  streamAppendMessageSchema,
  type ClockView,
  type CommandReceipt,
  type Json,
  type PlayerProjection,
  type ResolvedModuleSet,
  type StartOption,
  type IdPrefix,
} from "@ai-npc/contracts";
import {
  buildPlayerProjection,
  createServerApp,
  createTransportApp,
  type CommandReceiptReadPort,
  type ServerApp,
  type ServerAppInjectResponse,
  type TransportAppInput,
} from "@ai-npc/app-server";
import {
  accessPolicyModuleDefinition,
  type AccessPolicyPort,
} from "@ai-npc/mod-platform-access-policy-roster";
import type { ApprovedSpeechReader } from "@ai-npc/module-sdk";
import {
  TransportPort,
  type ConversationReadPort,
  type ConversationSourceLine,
} from "@ai-npc/mod-transport-http-ws-fastify";
import { SqliteSaveService } from "@ai-npc/mod-game-save-sqlite";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  operatorAuth,
  playerAuth,
  readGameClock,
  setGameClock,
  strategicAuth,
  withGamePorts,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];
const apps: Awaited<ReturnType<typeof createServerApp>>[] = [];
const clients: StreamClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  // 传输应用关闭失败时仍要释放 harness 的 SQLite 句柄；全部步骤完成后汇总错误。
  const failures: unknown[] = [];
  const closed = await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  for (const result of closed) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  try {
    await disposeTrackedGameHarnesses(active);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `服务端 API 测试清理未全部完成：${failures.length} 处失败`);
  }
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

/** 进入 stepping：写入模式与单步目标；返回的 ClockView 携带新的 runVersion。 */
function setClockStepping(harness: GameHarness, expected: number, ticks: number): ClockView {
  harness.storage.transact((tx) => {
    const table = tx.branch(harness.branchId).table("clock");
    const row = table.get({});
    if (row === null || Number(row["run_version"]) !== expected) {
      throw new Error("时钟版本冲突");
    }
    table.put({
      ...row,
      mode: "stepping",
      step_target_tick: Number(row["world_tick"]) + ticks,
      run_version: Number(row["run_version"]) + 1,
      updated_at: harness.host.nowIso(),
    });
  });
  return clockView(harness);
}

/** 分支业务表快照：验证授权拒绝发生在网关之前，没有回执、事件或世界状态写入。 */
function branchBusinessRows(harness: GameHarness) {
  return harness.storage.transact((tx) => ({
    receipts: tx.branch(harness.branchId).table("command_receipts").list(),
    events: tx.branch(harness.branchId).table("domain_events").list(),
    aggregates: tx.branch(harness.branchId).table("aggregate_state").list(),
    jobs: tx.branch(harness.branchId).table("jobs").list(),
    clock: tx.branch(harness.branchId).table("clock").get({}),
  }));
}

/** 持久化分支、run、快照与时钟；用于断言结构非法或冲突请求零写入。 */
function persistenceRows(harness: GameHarness) {
  return harness.storage.transact((tx) => ({
    branches: tx.rows("branches").list().map((row) => String(row["branch_id"])).sort(),
    runs: tx.rows("runs").list().map((row) => String(row["run_id"])).sort(),
    snapshots: tx.rows("snapshots").list().map((row) => String(row["snapshot_id"])).sort(),
    clock: tx.branch(harness.branchId).table("clock").get({}),
  }));
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
  assemblyHash: "test-server",
};

const clientAssembly: ResolvedModuleSet = {
  realm: "client",
  protocolVersion: "1",
  modules: [],
  capabilities: [],
  assemblyHash: "test-client",
};

const consoleAssembly: ResolvedModuleSet = {
  realm: "console",
  protocolVersion: "1",
  modules: [],
  capabilities: [],
  assemblyHash: "test-console",
};

/** 在真实只读端口上构建玩家投影；与宿主注入的构建函数一致。 */
function liveProjection(harness: GameHarness): PlayerProjection {
  const clock = readGameClock(harness);
  return withGamePorts(harness, (ports) =>
    buildPlayerProjection({
      content: harness.gameContent,
      clock,
      world: ports["game.world"],
      map: ports["game.map"],
      comms: ports["game.comms"],
      resources: ports["game.resources"],
      actions: ports["game.actions"],
      agreements: ports["game.agreements"],
    }),
  );
}

/** 从内容包派生开局选项，用于断言注入结果原样返回。 */
function contentStarts(harness: GameHarness): StartOption[] {
  return [...harness.gameContent.starts.values()]
    .filter((start) => start.enabled !== false)
    .map((start) => ({
      factionId: start.factionId,
      name: harness.gameContent.factions.get(start.factionId)?.name ?? start.factionId,
      commission: start.commission,
      contacts: start.contacts.map((agentId) => ({
        agentId,
        name:
          harness.gameContent.characters.get(agentId)?.name ??
          harness.gameContent.factions.get(agentId)?.leaderName ??
          agentId,
      })),
    }));
}

/** 用真实通信端口实现传输层会话读取端口；每个方法各自打开只读事务。 */
function conversationPort(harness: GameHarness): ConversationReadPort {
  return {
    worldTick: () => readGameClock(harness).worldTick,
    conversationsOf: (principalId) =>
      withGamePorts(harness, (ports) => ports["game.comms"].conversationsOf(principalId)),
    conversationMessages: (conversationId, limit) => {
      const lines = withGamePorts(
        harness,
        (ports) => ports["game.comms"].conversationMessages(conversationId, limit),
      );
      return lines.map((line) => {
        const event = harness.storage.transact((tx) =>
          tx.all(
            `SELECT world_seq
               FROM domain_events
              WHERE branch_id = ?
                AND type = 'DialogueSubmitted'
                AND json_extract(payload_json, '$.dialogueId') = ?`,
            [harness.branchId, line.dialogueId],
          )[0],
        );
        if (event === undefined) {
          throw new Error(`缺少对白 ${line.dialogueId} 的提交事件`);
        }
        return { ...line, worldSeq: Number(event["world_seq"]) };
      });
    },
    speakerName: (principalId) => harness.gameContent.characters.get(principalId)?.name ?? principalId,
  };
}

interface AppOverrides {
  readonly projection?: () => PlayerProjection;
  readonly pause?: () => ClockView;
  readonly reset?: () => { readonly branchId: string; readonly clock: ClockView };
  readonly now?: () => number;
  readonly starts?: () => readonly StartOption[];
  readonly conversation?: ConversationReadPort;
  /** 替换回执只读端口；缺省按真实回执表构造，用于验证传输层只经端口取回执。 */
  readonly receipts?: CommandReceiptReadPort;
  readonly sessionAssembly?: { readonly client: ResolvedModuleSet; readonly console: ResolvedModuleSet };
  /** 覆盖名册权限配置，用于验证裁决确实来自装配的 provider。 */
  readonly accessPolicyConfig?: Json;
  /** 收集传输层上报的内部错误；缺省保持静默。 */
  readonly onInternalError?: (message: string, error: unknown) => void;
  readonly consoleStaticDir?: string;
  /** 覆盖会话容量上限；用于验证满容量时的拒绝语义。 */
  readonly maxSessions?: number;
}

/** 用真实回执表构造只读查询端口；传输层不接触表结构。 */
function receiptsPortFor(harness: GameHarness): CommandReceiptReadPort {
  return {
    read: (principalId, branchId, commandId) =>
      harness.storage.transact((tx) => {
        const row = tx.branch(branchId).table("command_receipts").get({
          principal_id: principalId,
          command_id: commandId,
        });
        return row === null ? null : commandReceiptSchema.parse(row["receipt_json"]);
      }),
  };
}

/** 用真实名册模块与给定配置构造权限端口；传输层只经端口裁决。 */
async function accessPolicyFor(harness: GameHarness, config: Json = {}): Promise<AccessPolicyPort> {
  const instance = await accessPolicyModuleDefinition.create({
    moduleId: "platform.access-policy.roster",
    realm: "server",
    config,
    scope: {},
    ports: {},
    host: harness.host,
    signal: new AbortController().signal,
  });
  return instance.port as AccessPolicyPort;
}

async function appFor(harness: GameHarness, overrides: AppOverrides = {}) {
  const save = new SqliteSaveService(harness.storage, harness.host);
  const accessPolicy = await accessPolicyFor(harness, overrides.accessPolicyConfig ?? {});
  const app = await createServerApp({
    authority: harness.authority,
    accessPolicy,
    receipts: overrides.receipts ?? receiptsPortFor(harness),
    worldId: harness.worldId,
    branchId: harness.branchId,
    assembly,
    sessionAssembly: overrides.sessionAssembly ?? { client: clientAssembly, console: consoleAssembly },
    starts: overrides.starts ?? (() => []),
    projection: overrides.projection ?? (() => projection(clockView(harness))),
    clock: () => clockView(harness),
    ...(overrides.conversation === undefined
      ? {}
      : { conversation: overrides.conversation }),
    pause: (operationId: string, expected: number) => {
      void operationId;
      return overrides.pause === undefined ? setClockMode(harness, "paused", expected) : overrides.pause();
    },
    resume: (operationId: string, expected: number) => {
      void operationId;
      return setClockMode(harness, "running", expected);
    },
    step: (operationId: string, expected: number, ticks: number) => {
      void operationId;
      return setClockStepping(harness, expected, ticks);
    },
    save,
    reset: overrides.reset ?? (() => ({ branchId: harness.branchId, clock: clockView(harness) })),
    identities: [
      { token: "player-token", auth: playerAuth(harness) },
      // 第二个玩家用于验证会话读取只作用于认证主体。
      { token: "other-player-token", auth: { ...playerAuth(harness), principalId: "player-2" } },
      { token: "console-token", auth: operatorAuth(harness) },
      { token: "researcher-token", auth: { ...operatorAuth(harness), principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } },
    ],
    ids: (prefix: IdPrefix) => harness.host.ids(prefix),
    tokens: (kind) => `${kind}-${randomUUID()}`,
    ...(overrides.onInternalError === undefined ? {} : { onInternalError: overrides.onInternalError }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.consoleStaticDir === undefined
      ? {}
      : { consoleStaticDir: overrides.consoleStaticDir }),
    ...(overrides.maxSessions === undefined ? {} : { maxSessions: overrides.maxSessions }),
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
  const address = app.address();
  if (address === null) {
    throw new Error("没有监听端口");
  }
  return address.port;
}

/** 等待服务端处理完异步事件（如 WS 关闭）；超时明确失败。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
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

  it("命令回执经注入的只读端口返回，不依赖存储表", async () => {
    const value = await createTrackedGameHarness(active);
    const receipt: CommandReceipt = commandReceiptSchema.parse({
      receiptId: "rcp-000000000001",
      commandId: "cmd-000000000777",
      commandStatus: "accepted",
      reasonCode: null,
      safeMessage: null,
      acceptedEventIds: [],
      operationId: null,
      resultingVersions: {},
      result: null,
      worldTick: 4,
    });
    const calls: { readonly principalId: string; readonly branchId: string; readonly commandId: string }[] = [];
    const app = await appFor(value, {
      receipts: {
        read: (principalId, branchId, commandId) => {
          calls.push({ principalId, branchId, commandId });
          return commandId === receipt.commandId ? receipt : null;
        },
      },
    });
    const session = await login(app, "player-token");
    const headers = { authorization: `Bearer ${session}` };

    const found = await app.inject({ method: "GET", url: `/api/v1/commands/${receipt.commandId}`, headers });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual(receipt);
    // 主体与分支来自认证会话；传输层没有可用的存储句柄。
    expect(calls).toEqual([
      { principalId: "player-1", branchId: value.branchId, commandId: receipt.commandId },
    ]);

    const missing = await app.inject({ method: "GET", url: "/api/v1/commands/cmd-000000000778", headers });
    expect(missing.statusCode).toBe(404);
    expect(errorResponseSchema.parse(missing.json()).error.code).toBe("not-found");
  });

  it("GET /campaign 开局前返回空 campaign 与开局选项，开局后返回已开始的 campaign", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value, {
      projection: () => liveProjection(value),
      starts: () => contentStarts(value),
    });
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };

    const before = await app.inject({ method: "GET", url: "/api/v1/campaign", headers: auth });
    expect(before.statusCode).toBe(200);
    const beforeBody = campaignResponseSchema.parse(before.json());
    expect(beforeBody.campaign).toBeNull();
    expect(beforeBody.starts).toHaveLength(1);
    expect(beforeBody.starts.find((start) => start.factionId === "human-neutral")).toEqual({
      factionId: "human-neutral",
      name: "灰港公社",
      commission: "整理物资与消息，召集一次议事。",
      contacts: [
        { agentId: "npc-wenzhao", name: "闻昭" },
        { agentId: "npc-yinuo", name: "伊诺" },
        { agentId: "npc-wenyuan", name: "温原" },
      ],
    });

    const command = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd"));
    expect((await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: command })).statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/v1/campaign", headers: auth });
    expect(after.statusCode).toBe(200);
    const afterBody = campaignResponseSchema.parse(after.json());
    expect(afterBody.campaign).toMatchObject({
      factionId: "human-neutral",
      factionName: "灰港公社",
      status: "running",
      outcome: null,
      startTick: 0,
    });
    expect(afterBody.starts).toHaveLength(1);

    // 时钟随投影返回；campaign 响应只含 campaign 与开局选项。
    const view = await app.inject({ method: "GET", url: "/api/v1/world/view", headers: auth });
    expect(view.json()).toMatchObject({ projection: { clock: { worldTick: 0, mode: "running" } } });
  });

  it("GET /conversations/{agentId} 返回真实对白，选择最近一次交换并校验分页", async () => {
    const speeches: Record<string, import("@ai-npc/module-sdk").ApprovedSpeech> = {
      "art-000000000201": {
        text: "清单在仓里第三排。",
        agentId: "npc-wenyuan",
        turnId: "turn-000000000201",
        branchId: "br-000000000000",
        audience: ["player-1"],
        channel: "dialogue",
        approved: true,
      },
    };
    const reader: ApprovedSpeechReader = { read: (ref) => speeches[ref] ?? null };
    const value = await createTrackedGameHarness(active, { approvedSpeech: reader });
    const app = await appFor(value, { conversation: conversationPort(value) });
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };

    const start = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd"));
    expect((await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: start })).statusCode).toBe(200);

    const say = gameCommandEnvelope(
      "dialogue.say",
      { targetAgentId: "npc-wenyuan", text: "物资清单在哪里？" },
      value.host.ids("cmd"),
    );
    const said = await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: say });
    expect(said.statusCode).toBe(200);
    const conversationId = (said.json() as { readonly result: { readonly conversationId: string } }).result.conversationId;

    const reply = value.authority.commands.execute(
      strategicAuth(value, "npc-wenyuan"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "dialogue",
          conversationId,
          audience: ["player-1"],
          approvedSpeechArtifactRef: "art-000000000201",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(reply.commandStatus).toBe("accepted");

    const conversation = await app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan", headers: auth });
    expect(conversation.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(conversation.json())).toMatchObject({
      conversationId,
      lines: [
        { seq: 0, speakerId: "player-1", speakerName: "player-1", text: "物资清单在哪里？", channel: "face-to-face" },
        { seq: 1, speakerId: "npc-wenyuan", speakerName: "温原", text: "清单在仓里第三排。" },
      ],
    });

    const lastOnly = await app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?limit=1", headers: auth });
    expect(lastOnly.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(lastOnly.json()).lines.map((line) => line.seq)).toEqual([1]);

    const older = await app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?beforeSeq=1&limit=5", headers: auth });
    expect(older.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(older.json()).lines.map((line) => line.seq)).toEqual([0]);

    const empty = await app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?beforeSeq=0", headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(empty.json()).lines).toEqual([]);

    // 推进时钟后再次对话会创建新会话；接口返回最近一次交换所在的那一个。
    setGameClock(value, { worldTick: 1, mode: "running" });
    const secondSay = gameCommandEnvelope(
      "dialogue.say",
      { targetAgentId: "npc-wenyuan", text: "我晚点再来。" },
      value.host.ids("cmd"),
    );
    const secondSaid = await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: secondSay });
    expect(secondSaid.statusCode).toBe(200);
    const secondConversationId = (secondSaid.json() as { readonly result: { readonly conversationId: string } }).result.conversationId;
    expect(secondConversationId).not.toBe(conversationId);
    const latest = conversationResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan", headers: auth })).json(),
    );
    expect(latest.conversationId).toBe(secondConversationId);
    expect(latest.lines.map((line) => line.text)).toEqual(["我晚点再来。"]);

    expect((await app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?limit=101", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/conversations/npc-wenyuan?beforeSeq=-1", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/conversations/npc-unknown", headers: auth })).statusCode).toBe(404);

    // 另一个玩家不是当事人，读取同一会话得到 404 且不返回对白。
    const otherSession = await login(app, "other-player-token");
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/conversations/npc-wenyuan",
      headers: { authorization: `Bearer ${otherSession}` },
    });
    expect(denied.statusCode).toBe(404);
    expect(errorResponseSchema.parse(denied.json()).error.code).toBe("not-found");
  });

  it("GET /conversations 只返回已送达对白，未送达内容不下发", async () => {
    const value = await createTrackedGameHarness(active);
    const conversationId = value.host.ids("conv");
    const lateLine: ConversationSourceLine = {
      seq: 0,
      dialogueId: value.host.ids("dlg"),
      worldSeq: 1,
      speakerId: "npc-cenyan",
      text: "隘口暂时安全。",
      channel: "relay",
      worldTick: 0,
      deliveries: [{ principalId: "player-1", deliverAtTick: 5 }],
    };
    let tick = 0;
    const app = await appFor(value, {
      conversation: {
        worldTick: () => tick,
        conversationsOf: (principalId) =>
          principalId === "player-1" || principalId === "npc-cenyan" ? [conversationId] : [],
        conversationMessages: (_conversationId, limit) => [lateLine].slice(-limit),
        speakerName: (principalId) => (principalId === "npc-cenyan" ? "岑雁" : principalId),
      },
    });
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };

    const early = await app.inject({ method: "GET", url: "/api/v1/conversations/npc-cenyan", headers: auth });
    expect(early.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(early.json())).toEqual({ conversationId, lines: [] });

    tick = 5;
    const delivered = await app.inject({ method: "GET", url: "/api/v1/conversations/npc-cenyan", headers: auth });
    expect(delivered.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(delivered.json())).toEqual({
      conversationId,
      lines: [
        {
          seq: 0,
          dialogueId: lateLine.dialogueId,
          speakerId: "npc-cenyan",
          speakerName: "岑雁",
          text: "隘口暂时安全。",
          worldTick: 0,
          channel: "relay",
        },
      ],
    });
  });

  it("GET /conversations 在同一 tick 内按提交序号选择最新会话", async () => {
    const value = await createTrackedGameHarness(active);
    const olderConversationId = "conv-000000000002";
    const newerConversationId = "conv-000000000001";
    const line = (
      dialogueId: string,
      text: string,
      worldSeq: number,
    ): ConversationSourceLine => ({
      seq: 0,
      dialogueId,
      worldSeq,
      speakerId: "player-1",
      text,
      channel: "face-to-face",
      worldTick: 0,
      deliveries: [{ principalId: "player-1", deliverAtTick: 0 }],
    });
    const older = line(
      value.host.ids("dlg"),
      "较早提交",
      10,
    );
    const newer = line(
      value.host.ids("dlg"),
      "较晚提交",
      11,
    );
    // 较早会话的 ID 字典序更大，确保旧实现会稳定选错。
    expect(olderConversationId > newerConversationId).toBe(true);
    const app = await appFor(value, {
      conversation: {
        worldTick: () => 0,
        conversationsOf: (principalId) =>
          principalId === "player-1" || principalId === "npc-cenyan"
            ? [olderConversationId, newerConversationId]
            : [],
        conversationMessages: (conversationId) =>
          conversationId === olderConversationId ? [older] : [newer],
        speakerName: (principalId) => principalId,
      },
    });
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations/npc-cenyan",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(response.json())).toMatchObject({
      conversationId: newerConversationId,
      lines: [{ text: "较晚提交" }],
    });
  });

  it("GET /conversations 不会用尚未送达玩家的新会话遮蔽旧会话", async () => {
    const value = await createTrackedGameHarness(active);
    const visibleConversationId = "conv-000000000001";
    const pendingConversationId = "conv-000000000002";
    const line = (
      dialogueId: string,
      text: string,
      worldSeq: number,
      deliverAtTick: number,
    ): ConversationSourceLine => ({
      seq: 0,
      dialogueId,
      worldSeq,
      speakerId: "player-1",
      text,
      channel: "relay",
      worldTick: 0,
      deliveries: [{ principalId: "player-1", deliverAtTick }],
    });
    const visible = line(value.host.ids("dlg"), "已送达对白", 10, 0);
    const pending = line(value.host.ids("dlg"), "尚未送达对白", 11, 1);
    const app = await appFor(value, {
      conversation: {
        worldTick: () => 0,
        conversationsOf: (principalId) =>
          principalId === "player-1" || principalId === "npc-cenyan"
            ? [visibleConversationId, pendingConversationId]
            : [],
        conversationMessages: (conversationId) =>
          conversationId === visibleConversationId ? [visible] : [pending],
        speakerName: (principalId) => principalId,
      },
    });
    const session = await login(app, "player-token");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations/npc-cenyan",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(response.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(response.json())).toMatchObject({
      conversationId: visibleConversationId,
      lines: [{ text: "已送达对白" }],
    });
  });

  it("GET /conversations 使用实际尾行计算分页窗口并保留 beforeSeq 边界", async () => {
    const value = await createTrackedGameHarness(active);
    const conversationId = value.host.ids("conv");
    const lines: readonly ConversationSourceLine[] = Array.from({ length: 60 }, (_, seq) => ({
      seq,
      dialogueId: value.host.ids("dlg"),
      worldSeq: seq + 1,
      speakerId: "npc-cenyan",
      text: `第 ${seq} 条对白`,
      channel: "relay",
      worldTick: 0,
      deliveries: [{
        principalId: "player-1",
        deliverAtTick: seq < 30 ? 0 : 1,
      }],
    }));
    const app = await appFor(value, {
      conversation: {
        worldTick: () => 0,
        conversationsOf: (principalId) =>
          principalId === "player-1" || principalId === "npc-cenyan"
            ? [conversationId]
            : [],
        conversationMessages: (_conversationId, limit) => lines.slice(-limit),
        speakerName: (principalId) => principalId,
      },
    });
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };

    const latest = conversationResponseSchema.parse(
      (await app.inject({
        method: "GET",
        url: "/api/v1/conversations/npc-cenyan?limit=50",
        headers: auth,
      })).json(),
    );
    expect(latest.lines.map((line) => line.seq)).toEqual(
      Array.from({ length: 30 }, (_, seq) => seq),
    );

    const before = conversationResponseSchema.parse(
      (await app.inject({
        method: "GET",
        url: "/api/v1/conversations/npc-cenyan?beforeSeq=20&limit=50",
        headers: auth,
      })).json(),
    );
    expect(before.lines.map((line) => line.seq)).toEqual(
      Array.from({ length: 20 }, (_, seq) => seq),
    );
  });

  it("GET /session/assembly 按 realm 返回装配握手，玩家不能读取控制台装配", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value, {
      sessionAssembly: { client: clientAssembly, console: consoleAssembly },
    });
    const playerSession = await login(app, "player-token");
    const playerAuthHeader = { authorization: `Bearer ${playerSession}` };

    const client = await app.inject({ method: "GET", url: "/api/v1/session/assembly?realm=client", headers: playerAuthHeader });
    expect(client.statusCode).toBe(200);
    expect(sessionAssemblyResponseSchema.parse(client.json())).toEqual(clientAssembly);
    // 握手只含模块身份、能力与 hash，不含模块配置或秘密。
    expect(Object.keys(client.json() as object).sort()).toEqual([
      "assemblyHash",
      "capabilities",
      "modules",
      "protocolVersion",
      "realm",
    ]);

    const denied = await app.inject({ method: "GET", url: "/api/v1/session/assembly?realm=console", headers: playerAuthHeader });
    expect(denied.statusCode).toBe(403);
    expect(errorResponseSchema.parse(denied.json()).error.code).toBe("realm-violation");

    expect((await app.inject({ method: "GET", url: "/api/v1/session/assembly", headers: playerAuthHeader })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/session/assembly?realm=server", headers: playerAuthHeader })).statusCode).toBe(400);

    const consoleSession = await login(app, "console-token");
    const console = await app.inject({
      method: "GET",
      url: "/api/v1/session/assembly?realm=console",
      headers: { authorization: `Bearer ${consoleSession}` },
    });
    expect(console.statusCode).toBe(200);
    expect(sessionAssemblyResponseSchema.parse(console.json())).toEqual(consoleAssembly);

    // 会话描述同时给出服务端与客户端装配。
    const session = await app.inject({ method: "GET", url: "/api/v1/session", headers: playerAuthHeader });
    expect(session.json()).toMatchObject({
      serverAssembly: { realm: "server", assemblyHash: "test-server" },
      clientAssembly: { realm: "client", assemblyHash: "test-client" },
    });
  });

  it("健康、会话与装配握手使用集中登记的协议版本", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value, {
      sessionAssembly: { client: clientAssembly, console: consoleAssembly },
    });
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(healthResponseSchema.parse(health.json()).protocolVersion).toBe(protocolVersion);

    const sessionToken = await login(app, "player-token");
    const headers = { authorization: `Bearer ${sessionToken}` };
    const session = sessionDescriptorSchema.parse(
      (await app.inject({ method: "GET", url: "/api/v1/session", headers })).json(),
    );
    expect(session.protocolVersion).toBe(protocolVersion);
    const assembly = sessionAssemblyResponseSchema.parse(
      (await app.inject({
        method: "GET",
        url: "/api/v1/session/assembly?realm=client",
        headers,
      })).json(),
    );
    expect(assembly.protocolVersion).toBe(protocolVersion);
  });

  it("玩家读接口统一 401 与 403：未登录拒绝，控制台角色不能访问", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    for (const url of ["/api/v1/campaign", "/api/v1/conversations/npc-wenyuan", "/api/v1/session/assembly?realm=client"]) {
      const unauthenticated = await app.inject({ method: "GET", url });
      expect(unauthenticated.statusCode).toBe(401);
      expect(errorResponseSchema.parse(unauthenticated.json()).error.code).toBe("unauthenticated");
    }
    const consoleSession = await login(app, "console-token");
    const consoleAuth = { authorization: `Bearer ${consoleSession}` };
    for (const url of ["/api/v1/campaign", "/api/v1/conversations/npc-wenyuan"]) {
      const forbidden = await app.inject({ method: "GET", url, headers: consoleAuth });
      expect(forbidden.statusCode).toBe(403);
      expect(errorResponseSchema.parse(forbidden.json()).error.code).toBe("forbidden");
    }

    // 宿主尚未注入会话读取端口时明确返回未就绪，而不是伪造空会话。
    const playerSession = await login(app, "player-token");
    const unwired = await app.inject({
      method: "GET",
      url: "/api/v1/conversations/npc-wenyuan",
      headers: { authorization: `Bearer ${playerSession}` },
    });
    expect(unwired.statusCode).toBe(503);
    expect(errorResponseSchema.parse(unwired.json()).error.code).toBe("not-ready");
  });

  it("玩家入口在网关前按会话角色与命令类型裁决，被拒请求零写入", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const playerSession = await login(app, "player-token");
    const playerHeaders = { authorization: `Bearer ${playerSession}` };
    const consoleSession = await login(app, "console-token");
    const consoleHeaders = { authorization: `Bearer ${consoleSession}` };
    const before = branchBusinessRows(value);

    // 控制台会话不能读取玩家投影、会话或执行 campaign 控制。
    for (const url of ["/api/v1/campaign", "/api/v1/world/view", "/api/v1/conversations/npc-wenyuan"]) {
      const denied = await app.inject({ method: "GET", url, headers: consoleHeaders });
      expect(denied.statusCode).toBe(403);
      expect(errorResponseSchema.parse(denied.json()).error.code).toBe("forbidden");
    }
    const consoleCommand = gameCommandEnvelope(
      "campaign.start",
      { factionId: "human-neutral" },
      value.host.ids("cmd"),
    );
    const deniedCommand = await app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: consoleHeaders,
      payload: consoleCommand,
    });
    expect(deniedCommand.statusCode).toBe(403);
    const deniedPause = await app.inject({
      method: "POST",
      url: "/api/v1/campaign/pause",
      headers: consoleHeaders,
      payload: { operationId: "op-000000000901", expectedRunVersion: 0 },
    });
    expect(deniedPause.statusCode).toBe(403);
    expect(branchBusinessRows(value)).toEqual(before);

    // 玩家角色也不允许不在 playerCommands 中的命令；裁决早于网关，不写回执与事件。
    const forbiddenType = gameCommandEnvelope("scenario.draft", {}, value.host.ids("cmd"));
    const deniedType = await app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: playerHeaders,
      payload: forbiddenType,
    });
    expect(deniedType.statusCode).toBe(403);
    expect(errorResponseSchema.parse(deniedType.json()).error.code).toBe("forbidden");
    expect(branchBusinessRows(value)).toEqual(before);

    // 同一 commandId 没有留下任何回执。
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/commands/${forbiddenType.commandId}`,
      headers: playerHeaders,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("控制台入口要求会话持有的 X-Active-Role，并按装配策略放行", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const consoleSession = await login(app, "console-token");
    const consoleHeaders = { authorization: `Bearer ${consoleSession}` };

    const missing = await app.inject({ method: "GET", url: "/api/v1/console/health", headers: consoleHeaders });
    expect(missing.statusCode).toBe(403);
    expect(errorResponseSchema.parse(missing.json()).error.safeMessage).toContain("X-Active-Role");

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...consoleHeaders, "x-active-role": "admin" },
    });
    expect(invalid.statusCode).toBe(403);

    // 会话未持有的角色不能通过请求头自报。
    const notHeld = await app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...consoleHeaders, "x-active-role": "researcher" },
    });
    expect(notHeld.statusCode).toBe(403);

    // 默认名册只授权 operator；未注入控制台端口时返回 503 not-ready，不再伪造 ready 摘要。
    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { ...consoleHeaders, "x-active-role": "operator" },
    });
    expect(allowed.statusCode).toBe(503);
    expect(errorResponseSchema.parse(allowed.json()).error.code).toBe("not-ready");

    // 换装配配置后，同一入口按新名册拒绝 operator、放行 researcher。
    const customApp = await appFor(value, { accessPolicyConfig: { consoleRoles: ["researcher"] } });
    const customConsoleSession = await login(customApp, "console-token");
    const deniedOperator = await customApp.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { authorization: `Bearer ${customConsoleSession}`, "x-active-role": "operator" },
    });
    expect(deniedOperator.statusCode).toBe(403);
    const researcherSession = await login(customApp, "researcher-token");
    const allowedResearcher = await customApp.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { authorization: `Bearer ${researcherSession}`, "x-active-role": "researcher" },
    });
    // 权限已放行，但测试传输层没有控制台端口，兜底路径返回 503。
    expect(allowedResearcher.statusCode).toBe(503);
  });

  it("装配中的 playerCommands 改变命令裁决", async () => {
    const value = await createTrackedGameHarness(active);
    const restricted = await appFor(value, { accessPolicyConfig: { playerCommands: ["dialogue.say"] } });
    const restrictedSession = await login(restricted, "player-token");
    const before = branchBusinessRows(value);
    const denied = await restricted.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: { authorization: `Bearer ${restrictedSession}` },
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd")),
    });
    expect(denied.statusCode).toBe(403);
    expect(branchBusinessRows(value)).toEqual(before);

    // 默认名册下同一条命令被受理，证明差异来自装配的策略配置。
    const standard = await appFor(value);
    const standardSession = await login(standard, "player-token");
    const accepted = await standard.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: { authorization: `Bearer ${standardSession}` },
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd")),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ commandStatus: "accepted" });
  });

  it("WS 推送新对白与提醒的 append 帧，未订阅连接收不到", async () => {
    const speeches: Record<string, import("@ai-npc/module-sdk").ApprovedSpeech> = {
      "art-000000000101": {
        text: "清单在仓里第三排。",
        agentId: "npc-wenyuan",
        turnId: "turn-000000000101",
        branchId: "br-000000000000",
        audience: ["player-1"],
        channel: "dialogue",
        approved: true,
      },
    };
    const reader: ApprovedSpeechReader = { read: (ref) => speeches[ref] ?? null };
    const value = await createTrackedGameHarness(active, { approvedSpeech: reader });
    const app = await appFor(value, { projection: () => liveProjection(value) });
    const port = await listen(app);
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };

    const subscriber = openStream(port, await ticketFor(app, session));
    expect(await subscriber.next()).toMatchObject({ type: "hello", protocolVersion, principalId: "player-1", channels: ["player"] });
    subscriber.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await subscriber.next()).toMatchObject({ type: "snapshot", channel: "player", streamSeq: 0 });

    const idle = openStream(port, await ticketFor(app, session));
    expect(await idle.next()).toMatchObject({ type: "hello" });

    const start = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd"));
    expect((await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: start })).statusCode).toBe(200);
    expect(await subscriber.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 1 });

    const say = gameCommandEnvelope(
      "dialogue.say",
      { targetAgentId: "npc-wenyuan", text: "物资清单在哪里？" },
      value.host.ids("cmd"),
    );
    const said = await app.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: say });
    expect(said.statusCode).toBe(200);
    const conversationId = (said.json() as { readonly result: { readonly conversationId: string } }).result.conversationId;
    expect(await subscriber.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 2 });
    const firstAppend = streamAppendMessageSchema.parse(await subscriber.next());
    expect(firstAppend).toMatchObject({
      type: "append",
      channel: "player",
      streamSeq: 2,
      kind: "dialogue",
      item: { seq: 0, speakerId: "player-1", text: "物资清单在哪里？", channel: "face-to-face" },
    });

    // 角色回话经同一推送路径到达；连接只收到单条 append，而不是整份投影。
    const reply = value.authority.commands.execute(
      strategicAuth(value, "npc-wenyuan"),
      gameCommandEnvelope(
        "speech.commit",
        {
          channel: "dialogue",
          conversationId,
          audience: ["player-1"],
          approvedSpeechArtifactRef: "art-000000000101",
          intentKind: "answer",
          replyToId: null,
        },
        value.host.ids("cmd"),
      ),
    );
    expect(reply.commandStatus).toBe("accepted");
    app.notifyWorldChanged();
    expect(await subscriber.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 3 });
    const replyAppend = streamAppendMessageSchema.parse(await subscriber.next());
    expect(replyAppend).toMatchObject({
      type: "append",
      kind: "dialogue",
      item: { seq: 1, speakerId: "npc-wenyuan", speakerName: "温原", text: "清单在仓里第三排。" },
    });
    expect(Object.keys(replyAppend.item as object).sort()).toEqual([
      "channel",
      "dialogueId",
      "seq",
      "speakerId",
      "speakerName",
      "text",
      "worldTick",
    ]);

    // 新协议提案派生一条提醒，append 的 item 是单条提醒而非投影字段。
    const proposal = value.authority.commands.execute(
      strategicAuth(value, "human-neutral"),
      gameCommandEnvelope(
        "agreement.propose",
        {
          parties: ["player-1", "human-neutral"],
          terms: [
            {
              kind: "deliver",
              obligorId: "player-1",
              resource: "supply",
              amount: 5,
              fromStockpileId: "sp-commons",
              toStockpileId: "sp-earth",
              byTick: 20,
            },
          ],
        },
        value.host.ids("cmd"),
      ),
    );
    expect(proposal.commandStatus).toBe("accepted");
    app.notifyWorldChanged();
    expect(await subscriber.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 4 });
    const notificationAppend = streamAppendMessageSchema.parse(await subscriber.next());
    expect(notificationAppend).toMatchObject({
      type: "append",
      streamSeq: 4,
      kind: "notification",
      item: { kind: "invite", text: "收到新的协议提案", worldTick: 0 },
    });

    // 同一提醒在后续发布中不重复 append，也不把整份投影当作 append。
    app.notifyWorldChanged();
    expect(await subscriber.next()).toMatchObject({ type: "delta", streamSeq: 5 });
    await subscriber.expectNoMessage(100);

    await idle.expectNoMessage(100);
  });

  it("暂停与继续更新时钟版本", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };
    // 时钟只能在开局后继续；先以 t0 开局，再验证暂停/继续版本推进。
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers: auth,
      payload: gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd")),
    });
    expect(started.statusCode).toBe(200);
    const before = clockView(value);
    const paused = await app.inject({ method: "POST", url: "/api/v1/campaign/pause", headers: auth, payload: { operationId: "op-000000000001", expectedRunVersion: before.runVersion } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ mode: "paused", runVersion: before.runVersion + 1 });
    const resumed = await app.inject({ method: "POST", url: "/api/v1/campaign/resume", headers: auth, payload: { operationId: "op-000000000002", expectedRunVersion: before.runVersion + 1 } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ mode: "running", runVersion: before.runVersion + 2 });
  });

  it("控制台单步入口只对 operator 开放，玩家前缀不注册", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const consoleSession = await login(app, "console-token");
    const consoleAuth = { authorization: `Bearer ${consoleSession}`, "x-active-role": "operator" };

    const step = await app.inject({
      method: "POST",
      url: "/api/v1/console/campaign/step",
      headers: consoleAuth,
      payload: { operationId: "op-000000000011", expectedRunVersion: 0, ticks: 2 },
    });
    expect(step.statusCode).toBe(200);
    expect(step.json()).toMatchObject({ mode: "stepping", runVersion: 1 });
    expect(clockView(value)).toMatchObject({ mode: "stepping" });

    // ticks 越出公共契约上限返回 400；非法结构同样拒绝。
    const tooMany = await app.inject({
      method: "POST",
      url: "/api/v1/console/campaign/step",
      headers: consoleAuth,
      payload: { operationId: "op-000000000012", expectedRunVersion: 1, ticks: 25 },
    });
    expect(tooMany.statusCode).toBe(400);
    const missingTicks = await app.inject({
      method: "POST",
      url: "/api/v1/console/campaign/step",
      headers: consoleAuth,
      payload: { operationId: "op-000000000013", expectedRunVersion: 1 },
    });
    expect(missingTicks.statusCode).toBe(400);

    // 玩家会话没有 operator 角色：控制台单步按 403 拒绝；玩家前缀不注册 step 路由。
    const playerSession = await login(app, "player-token");
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/console/campaign/step",
      headers: { authorization: `Bearer ${playerSession}`, "x-active-role": "operator" },
      payload: { operationId: "op-000000000014", expectedRunVersion: 1, ticks: 1 },
    });
    expect(forbidden.statusCode).toBe(403);
    const playerPrefix = await app.inject({
      method: "POST",
      url: "/api/v1/campaign/step",
      headers: { authorization: `Bearer ${playerSession}` },
      payload: { operationId: "op-000000000015", expectedRunVersion: 1, ticks: 1 },
    });
    expect(playerPrefix.statusCode).toBe(404);
  });

  it("同一 commandId 同内容返回原回执，换 payload 返回 409", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const session = await login(app, "player-token");
    const headers = { authorization: `Bearer ${session}` };
    const command = gameCommandEnvelope("campaign.start", { factionId: "human-neutral" }, value.host.ids("cmd"));

    const executed = await app.inject({ method: "POST", url: "/api/v1/commands", headers, payload: command });
    expect(executed.statusCode).toBe(200);
    const first = executed.json() as { readonly receiptId: string; readonly commandStatus: string };
    expect(first.commandStatus).toBe("accepted");
    const afterFirst = branchBusinessRows(value);

    // 同键同内容重放返回原回执，不再写事件或回执。
    const replay = await app.inject({ method: "POST", url: "/api/v1/commands", headers, payload: command });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { readonly receiptId: string }).receiptId).toBe(first.receiptId);
    expect(branchBusinessRows(value)).toEqual(afterFirst);

    // 同键换 payload 是幂等冲突：409，且不留下新回执或领域事件。
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers,
      payload: { ...command, payload: { factionId: "human-pacifist" } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(errorResponseSchema.parse(conflict.json()).error).toMatchObject({
      code: "idempotency-conflict",
      retryable: false,
    });
    expect(branchBusinessRows(value)).toEqual(afterFirst);

    // 普通领域拒绝仍是 200 与 rejected receipt，不走 HTTP 错误。
    setGameClock(value, { worldTick: 0, mode: "paused" });
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/commands",
      headers,
      payload: gameCommandEnvelope("dialogue.say", { targetAgentId: "npc-wenyuan", text: "现在不能动。" }, value.host.ids("cmd")),
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ commandStatus: "rejected", reasonCode: "paused" });
  });

  it("所有非 2xx 响应使用统一错误结构，结构非法不写入", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const playerSession = await login(app, "player-token");
    const playerHeaders = { authorization: `Bearer ${playerSession}` };
    const consoleSession = await login(app, "console-token");
    const consoleHeaders = { authorization: `Bearer ${consoleSession}` };
    const before = persistenceRows(value);

    const cases: readonly {
      readonly label: string;
      readonly method: "GET" | "POST";
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly payload?: Record<string, Json>;
      readonly status: number;
      readonly code: string;
    }[] = [
      { label: "登录结构非法", method: "POST", url: "/api/v1/auth/login", payload: {}, status: 400, code: "validation" },
      // 与合法令牌等长但内容不同：登录仍按 401 拒绝，不因摘要索引而放行。
      {
        label: "登录令牌等长错误",
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { token: "player-tokeN" },
        status: 401,
        code: "unauthenticated",
      },
      { label: "未认证会话", method: "GET", url: "/api/v1/session", status: 401, code: "unauthenticated" },
      {
        label: "玩家访问控制台",
        method: "GET",
        url: "/api/v1/console/health",
        headers: { ...playerHeaders, "x-active-role": "operator" },
        status: 403,
        code: "forbidden",
      },
      { label: "未知路由", method: "GET", url: "/api/v1/unknown", status: 404, code: "not-found" },
      {
        label: "未知回执",
        method: "GET",
        url: "/api/v1/commands/cmd-000000000999",
        headers: playerHeaders,
        status: 404,
        code: "not-found",
      },
      {
        label: "命令信封结构非法",
        method: "POST",
        url: "/api/v1/commands",
        headers: playerHeaders,
        payload: { commandId: "cmd-000000000999", type: "campaign.start" },
        status: 400,
        code: "validation",
      },
      {
        label: "暂停缺少 operationId",
        method: "POST",
        url: "/api/v1/campaign/pause",
        headers: playerHeaders,
        payload: { expectedRunVersion: 0 },
        status: 400,
        code: "validation",
      },
      {
        label: "快照缺少 operationId",
        method: "POST",
        url: "/api/v1/campaign/snapshots",
        headers: playerHeaders,
        payload: { label: "缺少幂等键" },
        status: 400,
        code: "validation",
      },
      {
        label: "恢复缺少 operationId",
        method: "POST",
        url: "/api/v1/campaign/restore",
        headers: playerHeaders,
        payload: { snapshotId: "snap-000000000001" },
        status: 400,
        code: "validation",
      },
      {
        label: "重开缺少 operationId",
        method: "POST",
        url: "/api/v1/campaign/reset",
        headers: playerHeaders,
        payload: {},
        status: 400,
        code: "validation",
      },
      {
        label: "控制台缺少 X-Active-Role",
        method: "GET",
        url: "/api/v1/console/health",
        headers: consoleHeaders,
        status: 403,
        code: "forbidden",
      },
    ];
    for (const item of cases) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        ...(item.headers === undefined ? {} : { headers: item.headers }),
        ...(item.payload === undefined ? {} : { payload: item.payload }),
      });
      expect(response.statusCode, item.label).toBe(item.status);
      const body = errorResponseSchema.parse(response.json());
      expect(body.error.code, item.label).toBe(item.code);
      expect(body.error.safeMessage.length, item.label).toBeGreaterThan(0);
    }
    // 结构非法与认证/授权拒绝都不触碰业务写入。
    expect(persistenceRows(value)).toEqual(before);

    // 领域错误按 code 映射为 409；未预期异常统一为 500 plugin-failed。
    const versionApp = await appFor(value, {
      pause: () => {
        throw new DomainError("version-conflict", "时钟版本冲突");
      },
    });
    const versionSession = await login(versionApp, "player-token");
    const versionResponse = await versionApp.inject({
      method: "POST",
      url: "/api/v1/campaign/pause",
      headers: { authorization: `Bearer ${versionSession}` },
      payload: { operationId: "op-000000000901", expectedRunVersion: 0 },
    });
    expect(versionResponse.statusCode).toBe(409);
    expect(errorResponseSchema.parse(versionResponse.json()).error.code).toBe("version-conflict");

    const failedApp = await appFor(value, {
      reset: () => {
        throw new Error("注入的宿主故障");
      },
    });
    const failedSession = await login(failedApp, "player-token");
    const failed = await failedApp.inject({
      method: "POST",
      url: "/api/v1/campaign/reset",
      headers: { authorization: `Bearer ${failedSession}` },
      payload: { operationId: "op-000000000902" },
    });
    expect(failed.statusCode).toBe(500);
    expect(errorResponseSchema.parse(failed.json()).error.code).toBe("plugin-failed");
  });

  it("WS 首次订阅返回快照，命令后推送增量", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const session = await login(app, "player-token");
    const auth = { authorization: `Bearer ${session}` };
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello", protocolVersion, principalId: "player-1", channels: ["player"] });

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

  it("创建快照后向已订阅玩家推送投影变化", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value);
    const port = await listen(app);
    const session = await login(app, "player-token");
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello" });
    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", streamSeq: 0 });

    const snapshot = await app.inject({
      method: "POST",
      url: "/api/v1/campaign/snapshots",
      headers: { authorization: `Bearer ${session}` },
      payload: { operationId: "op-000000000051", label: "推送验证" },
    });
    expect(snapshot.statusCode).toBe(200);
    // 快照在运行中会先暂停时钟；已订阅客户端应立即收到新的投影增量。
    expect(await client.next()).toMatchObject({ type: "delta", channel: "player", streamSeq: 1 });
  });

  it("reports projection publish failures without throwing to the host", async () => {
    const value = await createTrackedGameHarness(active);
    let fail = false;
    const errors: string[] = [];
    const app = await appFor(value, {
      projection: () => {
        if (fail) {
          throw new Error("projection broken");
        }
        return projection(clockView(value));
      },
      onInternalError: (message) => errors.push(message),
    });
    fail = true;
    expect(() => app.notifyWorldChanged()).not.toThrow();
    expect(errors).toEqual(["projection publish failed", "projection resync failed"]);
  });

  it("rebuilds player snapshots after a projection publish failure", async () => {
    const value = await createTrackedGameHarness(active);
    const errors: string[] = [];
    let failNext = false;
    let current = projection(clockView(value));
    const app = await appFor(value, {
      projection: () => {
        if (failNext) {
          failNext = false;
          throw new Error("projection broken");
        }
        return current;
      },
      onInternalError: (message) => errors.push(message),
    });
    const port = await listen(app);
    const session = await login(app, "player-token");
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello" });
    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", streamSeq: 0, projectionVersion: 0 });

    // 发布失败前状态已经变化；快照必须反映新状态，而不是失败前的旧投影。
    current = {
      ...current,
      clock: { ...current.clock, worldTick: 7 },
      notifications: [...current.notifications, { kind: "urgent", text: "resync", worldTick: 7 }],
    };
    failNext = true;
    app.notifyWorldChanged();
    const snapshot = await client.next();
    expect(snapshot).toMatchObject({
      type: "snapshot",
      channel: "player",
      streamSeq: 0,
      data: { clock: { worldTick: 7 } },
    });
    expect((snapshot as { readonly data: PlayerProjection }).data.notifications).toContainEqual({
      kind: "urgent",
      text: "resync",
      worldTick: 7,
    });
    expect(errors).toEqual(["projection publish failed"]);

    // 快照已经包含该状态；下一次发布只发空增量，不能把同一条提醒重复追加。
    app.notifyWorldChanged();
    const delta = await client.next();
    expect(delta).toMatchObject({ type: "delta", channel: "player", streamSeq: 1, set: {} });
    expect(delta).not.toMatchObject({ type: "append" });
  });

  it("keeps a committed operation response when the internal error reporter throws", async () => {
    const value = await createTrackedGameHarness(active);
    const before = clockView(value);
    const errors: string[] = [];
    let fail = false;
    const app = await appFor(value, {
      projection: () => {
        if (fail) {
          throw new Error("projection broken");
        }
        return projection(clockView(value));
      },
      onInternalError: (message) => {
        errors.push(message);
        throw new Error("reporter broken");
      },
    });
    const session = await login(app, "player-token");
    fail = true;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/campaign/pause",
      headers: { authorization: `Bearer ${session}` },
      payload: { operationId: "op-000000000062", expectedRunVersion: before.runVersion },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: "paused", runVersion: before.runVersion + 1 });
    expect(errors).toEqual(["projection publish failed", "projection resync failed"]);
  });

  it("未预期异常返回 500 并经内部错误回调上报", async () => {
    const value = await createTrackedGameHarness(active);
    const errors: string[] = [];
    const app = await appFor(value, {
      pause: () => {
        throw new Error("injected failure");
      },
      onInternalError: (message) => errors.push(message),
    });
    const session = await login(app, "player-token");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/campaign/pause",
      headers: { authorization: `Bearer ${session}` },
      payload: { operationId: "op-000000000061", expectedRunVersion: 0 },
    });
    expect(response.statusCode).toBe(500);
    expect(errors).toContain("请求处理失败");
  });

  it("订阅后 delta 只携带变化顶层字段与版本号，未变化时为空", async () => {
    const value = await createTrackedGameHarness(active);
    let current = projection(clockView(value));
    const app = await appFor(value, { projection: () => current });
    const port = await listen(app);
    const session = await login(app, "player-token");
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello" });
    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", streamSeq: 0, projectionVersion: 0 });

    current = { ...current, clock: { ...current.clock, worldTick: 5 } };
    app.notifyWorldChanged();
    const delta = await client.next();
    expect(delta).toMatchObject({
      type: "delta",
      channel: "player",
      streamSeq: 1,
      projectionVersion: 1,
    });
    expect(Object.keys(delta["set"] as Record<string, unknown>)).toEqual(["clock"]);
    expect((delta["set"] as { readonly clock: unknown }).clock).toMatchObject({ worldTick: 5 });
    // 帧里不再出现完整投影。
    expect(delta).not.toHaveProperty("data");
    expect(JSON.stringify(delta["set"]).length).toBeLessThan(JSON.stringify(current).length);

    app.notifyWorldChanged();
    const heartbeat = await client.next();
    expect(heartbeat).toMatchObject({ type: "delta", streamSeq: 2, set: {} });
  });

  it("过期票据、断线重放缓冲与过期会话按上限清理且重连可恢复", async () => {
    const value = await createTrackedGameHarness(active);
    let current = Date.parse("2026-01-01T00:00:00.000Z");
    const app = await appFor(value, { now: () => current });
    const port = await listen(app);
    const session = await login(app, "player-token");
    const unusedTicket = await ticketFor(app, session);
    expect(app.streamStats()).toMatchObject({ sessions: 1, tickets: 1 });

    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello" });
    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", streamSeq: 0 });
    app.notifyWorldChanged();
    expect(await client.next()).toMatchObject({ type: "delta", streamSeq: 1 });
    client.close();
    await client.closed();
    await waitFor(() => app.streamStats().connections === 0);

    // 超过票据有效期与断线重放保留时间；下一次发布附带低频清理。
    current += 6 * 60 * 1000;
    app.notifyWorldChanged();
    expect(app.streamStats()).toMatchObject({ tickets: 0, replayBuffers: 0, connections: 0 });
    // 会话仍在 12 小时有效期内。
    expect(app.streamStats().sessions).toBe(1);

    // 旧游标的增量已被清理，重连仍按完整快照恢复。
    const reconnect = openStream(port, await ticketFor(app, session));
    expect(await reconnect.next()).toMatchObject({ type: "hello" });
    reconnect.send({ type: "subscribe", channel: "player", fromStreamSeq: 1 });
    expect(await reconnect.next()).toMatchObject({ type: "snapshot", channel: "player", streamSeq: 2 });

    // 未消费票据已过期，握手失败。
    const expired = openStream(port, unusedTicket);
    expect((await expired.closed()).code).toBe(4401);

    // 会话过期后由清理移除，旧令牌立即失效。
    current += 13 * 60 * 60 * 1000;
    app.notifyWorldChanged();
    expect(app.streamStats().sessions).toBe(0);
    const rejected = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(rejected.statusCode).toBe(401);
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
    // operator 不持有研究时间线频道；被拒订阅不进入推送集合。
    consoleClient.send({ type: "subscribe", channel: "console.timeline", fromStreamSeq: null });
    expect(await consoleClient.next()).toMatchObject({ type: "error", code: "forbidden" });
    app.notifyWorldChanged();
    await consoleClient.expectNoMessage(100);

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

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/campaign/reset",
      headers: auth,
      payload: { operationId: "op-000000000003" },
    });
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

  it("超过 WS 帧上限的连接以 1009 关闭，帧不进入消息处理器", async () => {
    const value = await createTrackedGameHarness(active);
    const reported: string[] = [];
    const app = await appFor(value, {
      onInternalError: (message) => {
        reported.push(message);
      },
    });
    const port = await listen(app);
    const session = await login(app, "player-token");
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello" });

    // 合法 subscribe 帧只有数百字节；带 70 KiB 填充的帧超过 64 KiB 上限。
    client.send({
      type: "subscribe",
      channel: "player",
      fromStreamSeq: null,
      padding: "x".repeat(70 * 1024),
    });
    expect((await client.closed()).code).toBe(1009);
    expect(reported).toContain("WS 帧超过上限");
    // 超限帧不进入处理器：连接关闭前没有 snapshot/error 等响应帧。
    await client.expectNoMessage(100);
    await waitFor(() => app.streamStats().connections === 0);
    expect(app.streamStats().sessions).toBe(1);
  });

  it("会话容量满时活跃连接保持在线，新登录返回 429", async () => {
    const value = await createTrackedGameHarness(active);
    const app = await appFor(value, { maxSessions: 1 });
    const port = await listen(app);
    const session = await login(app, "player-token");
    const client = openStream(port, await ticketFor(app, session));
    expect(await client.next()).toMatchObject({ type: "hello" });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { token: "player-token" },
    });
    expect(rejected.statusCode).toBe(429);
    const body = errorResponseSchema.parse(rejected.json());
    expect(body.error).toMatchObject({ code: "budget-exhausted", retryable: true });
    expect(body.error.safeMessage.length).toBeGreaterThan(0);

    // 活跃会话不被驱逐：原连接仍可订阅并收到快照，原令牌仍可读取会话。
    client.send({ type: "subscribe", channel: "player", fromStreamSeq: null });
    expect(await client.next()).toMatchObject({ type: "snapshot", channel: "player" });
    const stillAuthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { authorization: `Bearer ${session}` },
    });
    expect(stillAuthenticated.statusCode).toBe(200);
    expect(app.streamStats()).toMatchObject({ sessions: 1, connections: 1 });
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
    // 玩家即使自报控制台角色也没有持有该角色，控制台入口按 403 拒绝。
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { authorization: `Bearer ${session}`, "x-active-role": "operator" },
    });
    expect(forbidden.statusCode).toBe(403);
    const consoleSession = await login(app, "console-token");
    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/console/health",
      headers: { authorization: `Bearer ${consoleSession}`, "x-active-role": "operator" },
    });
    // 该测试应用没有注入控制台端口，授权通过后按 503 not-ready 拒绝。
    expect(allowed.statusCode).toBe(503);
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

  it("控制台构建前注册静态路由，产物出现后无需重启即可提供页面", async () => {
    const value = await createTrackedGameHarness(active);
    const directory = mkdtempSync(join(tmpdir(), "ai-npc-console-"));
    const staticDir = join(directory, "console-static");
    try {
      mkdirSync(staticDir);
      const app = await appFor(value, { consoleStaticDir: staticDir });
      const beforeBuild = await app.inject({ method: "GET", url: "/console/" });
      expect(beforeBuild.statusCode).toBe(404);

      writeFileSync(join(staticDir, "index.html"), "<div>console built</div>");
      const afterBuild = await app.inject({ method: "GET", url: "/console/timeline" });
      expect(afterBuild.statusCode).toBe(200);
      expect(afterBuild.body).toContain("console built");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("控制台静态目录创建失败时释放已初始化资源", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ai-npc-console-failure-"));
    const blocker = join(directory, "not-a-directory");
    writeFileSync(blocker, "blocked");
    let disposed = 0;
    try {
      await expect(
        createTransportApp({
          consoleStaticDir: join(blocker, "console-static"),
          disposeOnFailure: async () => {
            disposed += 1;
          },
        } as unknown as TransportAppInput),
      ).rejects.toThrow();
      expect(disposed).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("传输端口只经最小应用接口监听与关闭", async () => {
    const calls: string[] = [];
    const app: ServerApp = {
      listen: async (options) => {
        calls.push(`listen:${options.host}:${options.port}`);
      },
      close: async () => {
        calls.push("close");
      },
      inject: async () =>
        ({
          statusCode: 204,
          headers: {},
          body: "",
          json: () => null,
        }) as unknown as ServerAppInjectResponse,
      notifyWorldChanged: () => {
        calls.push("notify");
      },
      address: () => null,
      streamStats: () => ({ sessions: 0, tickets: 0, connections: 0, replayBuffers: 0 }),
    };
    const transport = new TransportPort({
      host: "127.0.0.1",
      port: 3100,
      allowedOrigins: ["http://127.0.0.1:5173"],
    });
    await transport.listen(app);
    await transport.close(app);
    expect(calls).toEqual(["listen:127.0.0.1:3100", "close"]);
  });
});
