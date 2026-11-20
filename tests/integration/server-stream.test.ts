/**
 * 验证 WS 流中心的投影增量、背压丢弃与快照恢复、会话/票据/重放缓冲清理与容量上限。
 * 依赖真实 StreamHub 与假 socket；不监听端口，也不依赖 Fastify 或浏览器 WebSocket。
 * 禁止用等待真实网络缓冲的方式制造慢连接，也不在用例间复用流中心。
 */
import { describe, expect, it } from "vitest";
import {
  playerProjectionSchema,
  type AuthContext,
  type PlayerProjection,
} from "@ai-npc/contracts";
import { StreamHub, type StreamSocket } from "@ai-npc/mod-transport-http-ws-fastify";

/** 假连接：记录发送帧并按需模拟背压缓冲与关闭事件。 */
class FakeSocket implements StreamSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  private readonly listeners = new Map<string, ((data?: unknown) => void)[]>();

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.emit("close");
  }

  terminate(): void {
    this.closed ??= { code: 1006, reason: "terminated" };
    this.emit("close");
  }

  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
  on(
    event: string,
    listener: ((data: { toString(): string }) => void) | (() => void),
  ): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (data?: unknown) => void);
    this.listeners.set(event, list);
    return undefined;
  }

  receive(message: Record<string, unknown>): void {
    this.emit("message", { toString: () => JSON.stringify(message) });
  }

  /** 取出并清空已发送帧，便于逐条断言。 */
  drain(): Record<string, unknown>[] {
    return this.sent.splice(0).map((payload) => JSON.parse(payload) as Record<string, unknown>);
  }

  private emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(data);
    }
  }
}

const playerAuth: AuthContext = {
  principalId: "player-1",
  kind: "player",
  roles: ["player"],
  worldId: "wld-test",
  branchId: "br-test",
  actingAsAgentId: null,
  controllerEpoch: null,
  turnLeaseEpoch: null,
  turnId: null,
};

function projection(worldTick: number, campaignId: string | null = null): PlayerProjection {
  return playerProjectionSchema.parse({
    campaign:
      campaignId === null
        ? null
        : {
            campaignId,
            factionId: "human-neutral",
            factionName: "中立方",
            commission: "第 7 日",
            status: "running",
            outcome: null,
            startTick: 0,
          },
    clock: { worldTick, day: Math.floor(worldTick / 24) + 1, hour: worldTick % 24, mode: "paused", runVersion: 0 },
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

let idCounter = 0;

function createHub(overrides: {
  readonly projection?: () => PlayerProjection;
  readonly now?: () => number;
  readonly maxBufferedBytes?: number;
  readonly sweepIntervalMs?: number;
  readonly replayRetentionMs?: number;
  readonly sessionTtlMs?: number;
  readonly ticketTtlMs?: number;
  readonly maxSessions?: number;
  readonly maxTickets?: number;
  readonly maxReplayBuffers?: number;
} = {}): StreamHub {
  const hub = new StreamHub({
    projection: overrides.projection ?? (() => projection(0)),
    channelsFor: () => ["player"],
    ids: (prefix) => {
      idCounter += 1;
      return `${prefix}-${String(idCounter).padStart(4, "0")}`;
    },
    tokens: (kind) => {
      idCounter += 1;
      return `${kind}-${String(idCounter).padStart(4, "0")}`;
    },
    now: overrides.now ?? (() => 0),
    ...(overrides.maxBufferedBytes === undefined ? {} : { maxBufferedBytes: overrides.maxBufferedBytes }),
    ...(overrides.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: overrides.sweepIntervalMs }),
    ...(overrides.replayRetentionMs === undefined ? {} : { replayRetentionMs: overrides.replayRetentionMs }),
    ...(overrides.sessionTtlMs === undefined ? {} : { sessionTtlMs: overrides.sessionTtlMs }),
    ...(overrides.ticketTtlMs === undefined ? {} : { ticketTtlMs: overrides.ticketTtlMs }),
    ...(overrides.maxSessions === undefined ? {} : { maxSessions: overrides.maxSessions }),
    ...(overrides.maxTickets === undefined ? {} : { maxTickets: overrides.maxTickets }),
    ...(overrides.maxReplayBuffers === undefined ? {} : { maxReplayBuffers: overrides.maxReplayBuffers }),
  });
  hub.setBranch("br-test");
  return hub;
}

/** 为已登录会话建立连接并完成订阅；返回假 socket。 */
function openStream(hub: StreamHub, sessionId: string, fromStreamSeq: number | null = null): FakeSocket {
  const socket = new FakeSocket();
  hub.accept(socket, hub.issueTicket(sessionId).ticket);
  socket.receive({ type: "subscribe", channel: "player", fromStreamSeq });
  return socket;
}

/** 解析并返回最后一个指定类型的帧；缺失时明确失败。 */
function lastFrame(socket: FakeSocket, type: string): Record<string, unknown> {
  const frames = socket.drain();
  const frame = frames.filter((candidate) => candidate["type"] === type).at(-1);
  if (frame === undefined) {
    throw new Error(`连接没有收到 ${type} 帧`);
  }
  return frame;
}

describe("WS 流中心", () => {
  it("订阅先发完整快照，delta 只携带变化的顶层字段", () => {
    let current = projection(0);
    const hub = createHub({ projection: () => current });
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      const socket = openStream(hub, session.sessionId);
      const snapshot = lastFrame(socket, "snapshot");
      expect(snapshot["data"]).toMatchObject({ clock: { worldTick: 0 } });

      current = projection(1);
      expect(hub.publish()).toBe(true);
      const delta = lastFrame(socket, "delta");
      const set = delta["set"] as Record<string, unknown>;
      expect(Object.keys(set)).toEqual(["clock"]);
      expect(set["clock"]).toMatchObject({ worldTick: 1 });
      expect(delta["streamSeq"]).toBe(1);
      expect(delta["projectionVersion"]).toBe(1);

      // 投影未变化时仍推进版本，但 set 为空，不再复制整份投影。
      hub.publish();
      const heartbeat = lastFrame(socket, "delta");
      expect(heartbeat["set"]).toEqual({});
      expect(heartbeat["streamSeq"]).toBe(2);

      // 命令只改 campaign 时，增量只含该字段。
      current = projection(1, "cmp-000000000001");
      hub.publish();
      const changed = lastFrame(socket, "delta");
      expect(Object.keys(changed["set"] as Record<string, unknown>)).toEqual(["campaign"]);
    } finally {
      hub.close();
    }
  });

  it("重同步不向已过期会话补发快照", () => {
    let now = 0;
    let failNext = false;
    const hub = createHub({
      projection: () => {
        if (failNext) {
          failNext = false;
          throw new Error("projection broken");
        }
        return projection(0);
      },
      now: () => now,
      sessionTtlMs: 100,
      sweepIntervalMs: 100_000,
    });
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      const socket = openStream(hub, session.sessionId);
      socket.drain();

      now = 101;
      failNext = true;
      hub.publishWithResync(() => {});

      // 会话在重同步前已过期：activeSession 撤销会话并关闭连接，不再补发玩家投影。
      expect(socket.closed).toMatchObject({ code: 4401, reason: "session expired" });
      expect(socket.sent).toEqual([]);
    } finally {
      hub.close();
    }
  });

  it("投影无法序列化时重同步只上报，不向调用方抛出", () => {
    const errors: string[] = [];
    const circular = projection(0) as PlayerProjection & { self?: unknown };
    circular.self = circular;
    let broken = false;
    const hub = createHub({ projection: () => (broken ? circular : projection(0)) });
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      const socket = openStream(hub, session.sessionId);
      socket.drain();

      broken = true;
      expect(() => hub.publishWithResync((message) => errors.push(message))).not.toThrow();
      expect(errors).toEqual(["projection publish failed", "projection resync failed"]);
      expect(socket.sent).toEqual([]);
    } finally {
      hub.close();
    }
  });

  it("慢连接超过缓冲阈值时丢弃增量并标记快照，不阻塞其他连接", () => {
    let current = projection(0);
    const hub = createHub({ projection: () => current, maxBufferedBytes: 128 });
    try {
      const fastSession = hub.login({ token: "player-login-token", auth: playerAuth });
      const slowSession = hub.login({ token: "player-login-token", auth: playerAuth });
      const fast = openStream(hub, fastSession.sessionId);
      const slow = openStream(hub, slowSession.sessionId);
      fast.drain();
      slow.drain();
      // 订阅快照已经送达，开始模拟慢连接的发送缓冲积压。
      slow.bufferedAmount = 1024;
      current = projection(1);
      hub.publish();

      expect(lastFrame(fast, "delta")["set"]).toMatchObject({ clock: { worldTick: 1 } });
      expect(slow.drain()).toEqual([]);

      // 连接恢复可写后，下一次发布先补完整快照，慢连接不会永久缺基线。
      slow.bufferedAmount = 0;
      hub.publish();
      const slowFrames = slow.drain();
      expect(slowFrames[0]).toMatchObject({ type: "snapshot", data: { clock: { worldTick: 1 } } });
      expect(slowFrames.some((frame) => frame["type"] === "delta")).toBe(true);
      expect(hub.stats().connections).toBe(2);
    } finally {
      hub.close();
    }
  });

  it("慢连接的 ping 不能绕过背压阈值，超过上限即断开", () => {
    const hub = createHub({ projection: () => projection(0), maxBufferedBytes: 128 });
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      const socket = openStream(hub, session.sessionId);
      socket.drain();
      socket.bufferedAmount = 1024;
      socket.receive({ type: "ping" });
      expect(socket.closed?.code).toBe(1013);
      expect(socket.drain().some((frame) => frame["type"] === "pong")).toBe(false);
      expect(hub.stats().connections).toBe(0);
    } finally {
      hub.close();
    }
  });

  it("过期会话、未消费票据与断线重放缓冲被清理，重连按游标恢复", () => {
    let current = projection(0);
    let now = 0;
    const hub = createHub({
      projection: () => current,
      now: () => now,
      sweepIntervalMs: 1000,
      replayRetentionMs: 500,
      sessionTtlMs: 1000,
      ticketTtlMs: 1000,
    });
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      const unusedTicket = hub.issueTicket(session.sessionId).ticket;
      const connected = openStream(hub, session.sessionId);
      connected.drain();
      current = projection(1);
      hub.publish();
      const streamSeq = lastFrame(connected, "delta")["streamSeq"] as number;
      connected.close(1000, "client closed");
      expect(hub.stats()).toMatchObject({ sessions: 1, replayBuffers: 1 });
      // 断线后保留缓冲仍可补发。
      current = projection(2);
      hub.publish();

      // 未过期前重连：按旧游标补发连续增量。
      now += 100;
      const reconnected = openStream(hub, session.sessionId, streamSeq);
      const replay = reconnected.drain();
      expect(replay.find((frame) => frame["type"] === "delta")).toMatchObject({
        type: "delta",
        streamSeq: streamSeq + 1,
      });

      // 会话与票据过期后不再可用。
      now += 2000;
      expect(hub.authenticate(session.token)).toBeNull();
      const expired = new FakeSocket();
      hub.accept(expired, unusedTicket);
      expect(expired.closed?.code).toBe(4401);

      hub.sweep();
      expect(hub.stats()).toMatchObject({ sessions: 0, tickets: 0, replayBuffers: 0 });

      // 旧会话的游标已无缓冲，新会话订阅按完整快照重建。
      const lateSession = hub.login({ token: "player-login-token", auth: playerAuth });
      const late = openStream(hub, lateSession.sessionId, 1);
      expect(lastFrame(late, "snapshot")).toMatchObject({ type: "snapshot" });
    } finally {
      hub.close();
    }
  });

  it("会话、票据与重放缓冲的数量不超过配置上限", () => {
    const hub = createHub({ maxSessions: 3, maxTickets: 2, maxReplayBuffers: 2 });
    try {
      const sessions = [0, 1, 2].map(() => hub.login({ token: "player-login-token", auth: playerAuth }));
      expect(hub.stats().sessions).toBe(3);
      hub.issueTicket(sessions[2]!.sessionId);
      hub.issueTicket(sessions[2]!.sessionId);
      hub.issueTicket(sessions[2]!.sessionId);
      expect(hub.stats().tickets).toBe(2);

      // 三个会话各自订阅；上限为 2 时淘汰最旧的缓冲而不是无限增长。
      for (const session of sessions) {
        openStream(hub, session.sessionId);
      }
      expect(hub.stats().replayBuffers).toBeLessThanOrEqual(2);
      expect(hub.stats().connections).toBe(3);
    } finally {
      hub.close();
    }
  });
});
