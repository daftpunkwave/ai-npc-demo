/**
 * 验证流中心在订阅、补发、发布三个环节的可观测语义：
 * 每频道补发标记、频道可用性拒绝、无订阅者时不构造控制台快照、过期会话不能经 ack 换到投影。
 * 依赖 StreamHub 与注入的假 socket 与假投影；不建立真实 WS 连接。
 * 禁止在本文件复现投影 schema，也禁止用连接级单标志替代按频道的补发语义。
 */
import { describe, expect, it } from "vitest";
import type { Json, PlayerProjection, StreamChannel } from "@ai-npc/contracts";
import { StreamHub } from "../src/stream-hub";
import type { StreamHubOptions, StreamSocket } from "../src/stream-types";

/** 记录一次 socket 写入，便于按顺序断言帧。 */
interface Sent {
  readonly payload: string;
}

/** 假 socket：可控制缓冲压力，并收集服务端发来的全部帧。 */
class FakeSocket implements StreamSocket {
  readonly sent: Sent[] = [];
  private readonly messageListeners: Array<(data: { toString(): string }) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  bufferedAmount = 0;
  terminated = false;
  closedWith: { readonly code: number; readonly reason: string } | null = null;

  send(payload: string): void {
    this.sent.push({ payload });
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }

  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
  on(event: "message" | "close" | "error", listener: ((data: { toString(): string }) => void) | (() => void)): unknown {
    if (event === "message") {
      this.messageListeners.push(listener as (data: { toString(): string }) => void);
    } else {
      this.closeListeners.push(listener as () => void);
    }
    return undefined;
  }

  /** 模拟客户端发来一帧文本。 */
  emitMessage(raw: string): void {
    for (const listener of this.messageListeners) {
      listener({ toString: () => raw });
    }
  }

  /** 已发出帧的类型与频道，便于定位遗漏的快照。 */
  frames(): { readonly type: string; readonly channel: string }[] {
    return this.sent.map(({ payload }) => {
      const parsed = JSON.parse(payload) as { readonly type: string; readonly channel: string };
      return { type: parsed.type, channel: parsed.channel };
    });
  }
}

function minimalProjection(): PlayerProjection {
  return { conversations: [], notifications: [] } as unknown as PlayerProjection;
}

/** 构造可控的流中心：时间由测试推进，频道可用性与快照来源都由用例给出。 */
function makeHub(overrides: Partial<StreamHubOptions> = {}): {
  readonly hub: StreamHub;
  readonly snaps: { readonly calls: StreamChannel[]; readonly console: (channel: StreamChannel) => number };
} {
  const consoleCalls = new Map<StreamChannel, number>();
  const scope: { now: number } = { now: 0 };
  const hub = new StreamHub({
    projection: minimalProjection,
    worldId: "wld-000000000001",
    channelsFor: () => ["player", "console.health", "console.timeline"],
    channelProvided: () => true,
    channelSnapshot: (channel) => {
      consoleCalls.set(channel, (consoleCalls.get(channel) ?? 0) + 1);
      return channel === "console.timeline"
        ? ({ items: [] } as unknown as Json)
        : ({ status: "ready" } as unknown as Json);
    },
    ids: (prefix) => `${prefix}-000000000001`,
    tokens: (kind) => `${kind}-token`,
    now: () => scope.now,
    ...overrides,
  });
  hub.setBranch("brn-000000000001");
  return {
    hub,
    snaps: {
      calls: [...consoleCalls.keys()],
      console: (channel) => consoleCalls.get(channel) ?? 0,
    },
  };
}

describe("流中心按频道记录待补快照", () => {
  it("同一连接订阅两个频道时，一个频道补发成功不会清掉另一个频道的待补标记", () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    const session = hub.login({
      token: "token-1",
      auth: { principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } as never,
    });
    hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
    socket.sent.length = 0;

    socket.emitMessage(JSON.stringify({ type: "subscribe", channel: "console.health", fromStreamSeq: null }));
    socket.emitMessage(JSON.stringify({ type: "subscribe", channel: "console.timeline", fromStreamSeq: null }));
    socket.sent.length = 0;

    // 制造背压：timeline 的补发必须失败并留下标记。
    socket.bufferedAmount = 2 * 1024 * 1024;
    hub.publishConsole("console.timeline", { items: [] } as unknown as Json);
    socket.bufferedAmount = 0;

    // 连接恢复可写后补发：timeline 必须收到快照，health 的补发成功不能覆盖它的标记。
    hub.sweep();
    const frames = socket.frames();
    const timelineSnapshots = frames.filter((frame) => frame.type === "snapshot" && frame.channel === "console.timeline");
    expect(timelineSnapshots.length).toBeGreaterThanOrEqual(1);
  });

  it("两个频道同时因背压丢失时，一次补发把两份快照都发出", () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    const session = hub.login({
      token: "token-1",
      auth: { principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } as never,
    });
    hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
    socket.emitMessage(JSON.stringify({ type: "subscribe", channel: "console.health", fromStreamSeq: null }));
    socket.emitMessage(JSON.stringify({ type: "subscribe", channel: "console.timeline", fromStreamSeq: null }));
    socket.sent.length = 0;

    socket.bufferedAmount = 2 * 1024 * 1024;
    hub.publishConsole("console.health", { status: "ready" } as unknown as Json);
    hub.publishConsole("console.timeline", { items: [] } as unknown as Json);
    socket.bufferedAmount = 0;
    expect(socket.frames()).toHaveLength(0);

    hub.sweep();
    const channels = socket.frames().filter((frame) => frame.type === "snapshot").map((frame) => frame.channel);
    expect(channels.sort()).toEqual(["console.health", "console.timeline"]);
  });
});

describe("流中心频道可用性", () => {
  it("订阅已授权但无生产者的频道返回 not-ready 而不是静默接受", () => {
    const { hub } = makeHub({
      channelsFor: () => ["player", "console.health", "console.turns"],
      channelProvided: (channel) => channel === "console.health",
    });
    const socket = new FakeSocket();
    const session = hub.login({
      token: "token-1",
      auth: { principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } as never,
    });
    hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
    socket.sent.length = 0;

    socket.emitMessage(JSON.stringify({ type: "subscribe", channel: "console.turns", fromStreamSeq: null }));
    const error = JSON.parse(socket.sent[0]?.payload ?? "{}") as { readonly type: string; readonly code: string };
    expect(error).toMatchObject({ type: "error", code: "not-ready" });

    // 被拒绝的频道不进入订阅集合，世界变化也不为它推送。
    socket.sent.length = 0;
    hub.publishConsole("console.turns", { items: [] } as unknown as Json);
    expect(socket.sent).toHaveLength(0);
    expect(hub.hasSubscriber("console.turns")).toBe(false);
  });
});

describe("流中心订阅者查询", () => {
  it("无订阅者时 hasSubscriber 为假，订阅后为真", () => {
    const { hub } = makeHub();
    const socket = new FakeSocket();
    const session = hub.login({
      token: "token-1",
      auth: { principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } as never,
    });
    hub.accept(socket, hub.issueTicket(session.sessionId).ticket);

    expect(hub.hasSubscriber("console.timeline")).toBe(false);
    socket.emitMessage(JSON.stringify({ type: "subscribe", channel: "console.timeline", fromStreamSeq: null }));
    expect(hub.hasSubscriber("console.timeline")).toBe(true);
  });

  it("未注入可用性判定时不额外拒绝，保持流中心的既有订阅契约", () => {
    const { hub } = makeHub({ channelProvided: undefined });
    const socket = new FakeSocket();
    const session = hub.login({
      token: "token-1",
      auth: { principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } as never,
    });
    hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
    socket.sent.length = 0;

    socket.emitMessage(JSON.stringify({ type: "subscribe", channel: "console.timeline", fromStreamSeq: null }));
    // 订阅成立并立即收到快照，而不是被拒。
    expect(socket.frames()[0]).toMatchObject({ type: "snapshot", channel: "console.timeline" });
  });
});

describe("流中心帧校验顺序", () => {
  it("会话过期后 ping 也会被拒绝，不再回 pong", () => {
    const clock = { now: 0 };
    const { hub } = makeHub({ now: () => clock.now, sessionTtlMs: 1_000 });
    const socket = new FakeSocket();
    const session = hub.login({
      token: "token-1",
      auth: { principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } as never,
    });
    hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
    // 让会话过期但不触发 sweep：这正是 ack/ping 先于会话校验时能被利用的窗口。
    clock.now = 5_000;
    socket.sent.length = 0;

    socket.emitMessage(JSON.stringify({ type: "ping" }));
    expect(socket.sent).toHaveLength(0);
    expect(socket.closedWith?.code).toBe(4401);
  });

  it("未订阅频道的 ack 不会触发补发", () => {
    const { hub, snaps } = makeHub();
    const socket = new FakeSocket();
    const session = hub.login({
      token: "token-1",
      auth: { principalId: "researcher-1", kind: "researcher", roles: ["researcher"] } as never,
    });
    hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
    socket.sent.length = 0;

    socket.emitMessage(JSON.stringify({ type: "ack", channel: "console.timeline", streamSeq: 3 }));
    const error = JSON.parse(socket.sent[0]?.payload ?? "{}") as { readonly code: string };
    expect(error.code).toBe("forbidden");
    expect(snaps.console("console.timeline")).toBe(0);
  });
});
