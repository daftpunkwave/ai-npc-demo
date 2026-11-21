/**
 * 覆盖流连接退避、成功重置与会话失效停止重连，以及关闭码和票据错误的分类。
 * 依赖内存 API 端口与假 WebSocket；不启动真实网络或浏览器。
 * 禁止依赖真实计时器，也不允许把主动关闭当成断线重连。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, playerProjectionSchema, type HostServices, type ModuleCreateInput, type SessionDescriptor } from "@ai-npc/contracts";
import type { ApiClient } from "@ai-npc/client-protocol";
import { createWorldViewModule, type WorldViewPort } from "../src/plugin";
import {
  isSessionInvalidCloseCode,
  isSessionInvalidError,
  reconnectDelayMs,
} from "../src/connection-policy";

const session: SessionDescriptor = {
  principalId: "player-1",
  roles: ["player"],
  worldId: "wld-000000000001",
  branchId: "br-000000000001",
  protocolVersion: "1",
  serverAssembly: {
    realm: "server",
    protocolVersion: "1",
    modules: [],
    capabilities: [],
    assemblyHash: "server",
  },
  clientAssembly: null,
};

const projection = playerProjectionSchema.parse({
  campaign: {
    campaignId: "cmp-000000000001",
    factionId: "human-neutral",
    factionName: "灰港公社",
    commission: "守住水闸",
    status: "running",
    outcome: null,
    startTick: 0,
  },
  clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
  map: { nodes: [], roads: [] },
  meters: null,
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

const content = {
  chapterTitle: "水闸之前",
  clock: { secondsPerTick: 20, evaluationTick: 168, motionTick: 144 },
  ui: {
    noReply: "（对方暂未回应）",
    waitingReply: "等待回应",
    reconnecting: "重连中",
    serverUnavailable: "服务端不可连接",
    sessionExpired: "会话已失效，请重新登录。",
    incompleteAssembly: "组合不完整",
    moduleNotLoaded: "模块未装载",
    chapterKicker: "序章 / 第一周",
    startBriefing: "开场白",
    hudKicker: "灰港 / 序章",
    siteLabel: "灰港现场",
    sceneLabel: "灰港近城",
    consoleTitle: "灰港控制台",
  },
};

type SocketListener = (event: { readonly code?: number; readonly data?: string }) => void;

/** 只实现 StreamClient 用到的 WebSocket 表面，由测试控制连接与关闭时点。 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  private readonly listeners = new Map<string, Set<SocketListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const group = this.listeners.get(type) ?? new Set<SocketListener>();
    group.add(listener);
    this.listeners.set(type, group);
  }

  send(): void {
    // 测试不接受客户端帧。
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  /** 推送一条服务端帧；用于证明连接已可用并重置退避计数。 */
  serverMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: { readonly code?: number; readonly data?: string }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

/** 服务端建连后的首帧；玩家流连接收到它即视为可用。 */
const hello = {
  type: "hello",
  protocolVersion: "1",
  principalId: "player-1",
  channels: ["player"],
};

const host: HostServices = {
  ids: (prefix) => `${prefix}-000000000001`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
  monotonicMs: () => 0,
  sleep: async () => undefined,
  rng: () => () => 0.5,
  hash: async () => "hash",
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  tracer: { span: (_name, _attrs, fn) => fn() },
};

function moduleInput(api: ApiClient): ModuleCreateInput {
  return {
    moduleId: "client.world-view.standard",
    realm: "client",
    config: {},
    scope: {},
    ports: {
      "host.api": api,
      "host.command": { send: async () => undefined },
      "host.session": session,
    },
    host,
    signal: new AbortController().signal,
  };
}

interface ApiHarness {
  readonly api: ApiClient;
  readonly tickets: () => number;
  readonly cleared: () => number;
  readonly ticket: ReturnType<typeof vi.fn>;
  readonly clearSession: ReturnType<typeof vi.fn>;
}

function apiHarness(onTicket: () => Promise<{ readonly ticket: string }>): ApiHarness {
  const ticket = vi.fn(onTicket);
  const clearSession = vi.fn();
  const api = {
    content: async () => content,
    campaign: async () => ({ campaign: projection.campaign, starts: [] }),
    worldView: async () => ({ streamSeq: 1, projectionVersion: 1, projection }),
    streamTicket: ticket,
    webSocketUrl: (value: string) => `ws://test/${value}`,
    clearSession,
  } as unknown as ApiClient;
  return {
    api,
    ticket,
    clearSession,
    tickets: () => ticket.mock.calls.length,
    cleared: () => clearSession.mock.calls.length,
  };
}

interface TestPort {
  readonly port: WorldViewPort;
  readonly dispose: () => Promise<void>;
}

async function createPort(harness: ApiHarness): Promise<TestPort> {
  const instance = await createWorldViewModule(moduleInput(harness.api));
  return {
    port: instance.port as WorldViewPort,
    dispose: async () => instance.dispose(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("重连退避策略", () => {
  it("按指数增长、抖动有界并在上限处封顶", () => {
    expect(reconnectDelayMs(1, () => 0.5)).toBe(1_000);
    expect(reconnectDelayMs(2, () => 0.5)).toBe(2_000);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(4_000);
    expect(reconnectDelayMs(10, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(1, () => 0)).toBe(800);
    expect(reconnectDelayMs(1, () => 0.999_999)).toBeLessThanOrEqual(1_200);
    expect(reconnectDelayMs(20, () => 0.999_999)).toBe(30_000);
  });

  it("只把 4401 与未认证/无权限错误归为会话失效", () => {
    expect(isSessionInvalidCloseCode(4401)).toBe(true);
    for (const code of [1000, 1006, 4400, 5000]) {
      expect(isSessionInvalidCloseCode(code)).toBe(false);
    }
    expect(isSessionInvalidError(new DomainError("unauthenticated", "登录已失效"))).toBe(true);
    expect(isSessionInvalidError(new DomainError("forbidden", "无权访问"))).toBe(true);
    expect(isSessionInvalidError(new DomainError("provider-failed", "网络错误"))).toBe(false);
    expect(isSessionInvalidError(new Error("boom"))).toBe(false);
  });
});

describe("世界视图流连接", () => {
  it("断线后退避递增，连接成功后计数归零", async () => {
    const harness = apiHarness(async () => ({ ticket: "ticket-1" }));
    const { port, dispose } = await createPort(harness);
    await port.bootstrap();
    expect(port.getContent()).toEqual(content);
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.serverMessage(hello);
    expect(port.getConnectionState()).toMatchObject({ kind: "connected", attempt: 0 });

    FakeWebSocket.instances[0]?.serverClose(1006);
    expect(port.getConnectionState()).toMatchObject({
      kind: "reconnecting",
      attempt: 1,
      retryInMs: 1_000,
    });
    expect(harness.tickets()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(harness.tickets()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.tickets()).toBe(2);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]?.serverClose(1006);
    expect(port.getConnectionState()).toMatchObject({
      kind: "reconnecting",
      attempt: 2,
      retryInMs: 2_000,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2]?.open();
    // 仅建连尚未收到服务端帧时保留退避计数。
    expect(port.getConnectionState()).toMatchObject({ kind: "connected", attempt: 2 });
    FakeWebSocket.instances[2]?.serverMessage(hello);
    expect(port.getConnectionState()).toMatchObject({ kind: "connected", attempt: 0 });

    FakeWebSocket.instances[2]?.serverClose(1006);
    expect(port.getConnectionState()).toMatchObject({ kind: "reconnecting", attempt: 1 });
    await dispose();
  });

  it("连接刚打开即断开时保留退避计数，避免固定 1 秒重试", async () => {
    const harness = apiHarness(async () => ({ ticket: "ticket-1" }));
    const { port, dispose } = await createPort(harness);
    await port.bootstrap();
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.serverMessage(hello);
    FakeWebSocket.instances[0]?.serverClose(1006);
    expect(port.getConnectionState()).toMatchObject({ kind: "reconnecting", attempt: 1 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]?.open();
    FakeWebSocket.instances[1]?.serverClose(1006);
    expect(port.getConnectionState()).toMatchObject({
      kind: "reconnecting",
      attempt: 2,
      retryInMs: 2_000,
    });
    await dispose();
  });

  it("主动关闭连接不会触发重连", async () => {
    const harness = apiHarness(async () => ({ ticket: "ticket-1" }));
    const { port, dispose } = await createPort(harness);
    await port.bootstrap();
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.serverMessage(hello);
    const requests = harness.tickets();
    await dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.tickets()).toBe(requests);
    expect(port.getConnectionState()).toMatchObject({ kind: "connected" });
  });

  it("收到 4401 关闭码后停止重连并清除本地会话", async () => {
    const harness = apiHarness(async () => ({ ticket: "ticket-1" }));
    const { port, dispose } = await createPort(harness);
    await port.bootstrap();
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.serverClose(4401);

    expect(port.getConnectionState()).toMatchObject({ kind: "session-expired" });
    expect(harness.cleared()).toBe(1);
    const requests = harness.tickets();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.tickets()).toBe(requests);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await dispose();
  });

  it("票据请求返回 401/403 时停止重连", async () => {
    const harness = apiHarness(async () => {
      throw new DomainError("unauthenticated", "登录已失效");
    });
    const { port, dispose } = await createPort(harness);
    await port.bootstrap();

    expect(port.getConnectionState()).toMatchObject({ kind: "session-expired" });
    expect(harness.cleared()).toBe(1);
    expect(harness.tickets()).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.tickets()).toBe(1);
    await dispose();
  });
});
