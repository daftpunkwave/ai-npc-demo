/**
 * 核心职责：验证流中心用心跳往返识别并回收半开连接，且在回收时正确递减玩家连接计数。
 * 交互契约：注入可控时钟与假 socket；不建立真实 WS 连接、不依赖真实定时器。
 * 约束与禁忌：禁止只断言「发出了 ping」而不验证失联连接被清理与计数下降。
 */
import { describe, expect, it } from "vitest";
import type { PlayerProjection } from "@ai-npc/contracts";
import { StreamHub } from "../src/stream-hub";
import type { StreamHubOptions, StreamSocket } from "../src/stream-types";

/** 记录写入帧并可控缓冲压力的假 socket；心跳相关断言只需帧类型与终止标记。 */
class FakeSocket implements StreamSocket {
  readonly sent: string[] = [];
  private readonly messageListeners: Array<(data: { toString(): string }) => void> = [];
  bufferedAmount = 0;
  terminated = false;
  closedWith: { readonly code: number; readonly reason: string } | null = null;

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }

  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
  on(
    event: "message" | "close" | "error",
    listener: ((data: { toString(): string }) => void) | (() => void),
  ): unknown {
    if (event === "message") {
      this.messageListeners.push(listener as (data: { toString(): string }) => void);
    }
    return undefined;
  }

  emitMessage(raw: string): void {
    for (const listener of this.messageListeners) {
      listener({ toString: () => raw });
    }
  }

  /** 已写出帧的类型序列，用于区分 ping、hello 与快照。 */
  frameTypes(): string[] {
    return this.sent.map((payload) => (JSON.parse(payload) as { readonly type: string }).type);
  }
}

function minimalProjection(): PlayerProjection {
  return { conversations: [], notifications: [] } as unknown as PlayerProjection;
}

/** 构造启用玩家频道的最小流中心；时钟由测试推进，心跳窗口压到毫秒级。 */
function makeHub(overrides: Partial<StreamHubOptions> = {}): {
  readonly hub: StreamHub;
  readonly scope: { now: number };
} {
  const scope = { now: 1_000 };
  const hub = new StreamHub({
    projection: minimalProjection,
    worldId: "wld-000000000001",
    channelsFor: () => ["player"],
    ids: (prefix) => `${prefix}-000000000001`,
    tokens: (kind) => `${kind}-token`,
    now: () => scope.now,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 3_000,
    ...overrides,
  });
  hub.setBranch("brn-000000000001");
  return { hub, scope };
}

/** 建立一条已握手的玩家连接，并清空握手帧以便断言后续心跳帧。 */
function connectPlayer(hub: StreamHub): FakeSocket {
  const socket = new FakeSocket();
  const session = hub.login({
    token: "token-1",
    auth: { principalId: "player-1", kind: "player", roles: ["player"] } as never,
  });
  hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
  socket.sent.length = 0;
  return socket;
}

describe("流中心心跳活性判定", () => {
  it("超过超时窗口没有收到任何帧时终止连接并递减玩家连接计数", () => {
    const counts: number[] = [];
    const { hub, scope } = makeHub({
      onPlayerConnectionsChanged: (connected) => counts.push(connected),
    });
    const socket = connectPlayer(hub);
    expect(hub.stats().connections).toBe(1);
    expect(counts).toEqual([1]);

    // 窗口内保持活跃判定：不清理，只发 ping。
    scope.now += 2_000;
    hub.heartbeat();
    expect(socket.terminated).toBe(false);
    expect(socket.frameTypes()).toContain("ping");

    // 超过超时窗口：连接被判为半开并终止，计数必须真的降到 0。
    scope.now += 2_000;
    hub.heartbeat();
    expect(socket.terminated).toBe(true);
    expect(hub.stats().connections).toBe(0);
    expect(counts).toEqual([1, 0]);
  });

  it("收到任意帧都会刷新存活时间，包括对 ping 的 pong 回执", () => {
    const { hub, scope } = makeHub();
    const socket = connectPlayer(hub);

    scope.now += 2_000;
    hub.heartbeat();
    expect(socket.frameTypes()).toEqual(["ping"]);

    // 回 pong 是证明对端仍在收的唯一证据；不回就会被判死。
    socket.emitMessage(JSON.stringify({ type: "pong" }));
    scope.now += 2_000;
    hub.heartbeat();

    expect(socket.terminated).toBe(false);
    expect(hub.stats().connections).toBe(1);
  });

  it("注销会话时连接立即关闭，心跳不再依赖失联判定回收它", () => {
    const counts: number[] = [];
    const { hub } = makeHub({
      onPlayerConnectionsChanged: (connected) => counts.push(connected),
    });
    const socket = connectPlayer(hub);

    // 注销直接撤销会话并关闭其全部连接：不必等心跳超时，计数当即归零。
    hub.logout("session-token");
    expect(socket.closedWith).toMatchObject({ code: 4401 });
    expect(hub.stats().connections).toBe(0);
    expect(counts).toEqual([1, 0]);
  });

  it("心跳间隔与超时是显式边界：超时不大于间隔时拒绝构造", () => {
    expect(() =>
      new StreamHub({
        projection: minimalProjection,
        worldId: "wld-000000000001",
        channelsFor: () => ["player"],
        ids: (prefix) => `${prefix}-000000000001`,
        tokens: (kind) => `${kind}-token`,
        now: () => 0,
        heartbeatIntervalMs: 5_000,
        heartbeatTimeoutMs: 5_000,
      }),
    ).toThrow(/heartbeatTimeoutMs/);
  });
});
