/**
 * 验证 WS 流中心的投影增量、背压丢弃与快照恢复、会话/票据/重放缓冲清理与容量上限。
 * 依赖真实 StreamHub 与假 socket；不监听端口，也不依赖 Fastify 或浏览器 WebSocket。
 * 禁止用等待真实网络缓冲的方式制造慢连接，也不在用例间复用流中心。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DomainError,
  playerProjectionSchema,
  type AuthContext,
  type Json,
  type PlayerProjection,
  type StreamChannel,
} from "@ai-npc/contracts";
import { StreamHub, type StreamSocket } from "@ai-npc/mod-transport-http-ws-fastify";

/** 假连接：记录发送帧并按需模拟背压缓冲与关闭事件。 */
class FakeSocket implements StreamSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  /** 底层连接被强制终止的次数；用于区分「只发关闭帧」与「确保释放」。 */
  terminateCount = 0;
  private readonly listeners = new Map<string, ((data?: unknown) => void)[]>();

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.emit("close");
  }

  terminate(): void {
    this.terminateCount += 1;
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
  readonly maxConnections?: number;
  readonly maxConnectionsPerSession?: number;
  readonly channelsFor?: (auth: AuthContext) => readonly StreamChannel[];
  readonly channelSnapshot?: (channel: StreamChannel) => Json | null;
} = {}): StreamHub {
  const hub = new StreamHub({
    projection: overrides.projection ?? (() => projection(0)),
    worldId: "wld-000000000001",
    channelsFor: overrides.channelsFor ?? (() => ["player"]),
    ...(overrides.channelSnapshot === undefined ? {} : { channelSnapshot: overrides.channelSnapshot }),
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
    ...(overrides.maxConnections === undefined ? {} : { maxConnections: overrides.maxConnections }),
    ...(overrides.maxConnectionsPerSession === undefined
      ? {}
      : { maxConnectionsPerSession: overrides.maxConnectionsPerSession }),
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
      // 票据在会话语义上已不可用（票据已过 TTL），握手以票据关闭码拒绝。
      expect(expired.closed?.code).toBe(4408);

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

  it("连接上限必须是正整数，非法配置显式失败而不是静默取消上限", () => {
    // NaN 参与比较恒为 false，等于静默取消上限；负数与 Infinity 同样让容量检查失效。
    // 这些配置错误必须在构造时就暴露，不能回退默认值掩盖调用方意图。
    const invalid: readonly (readonly [string, number])[] = [
      ["maxConnections", Number.NaN],
      ["maxConnections", Number.POSITIVE_INFINITY],
      ["maxConnections", 0],
      ["maxConnections", -1],
      ["maxConnections", 1.5],
      ["maxConnectionsPerSession", Number.NaN],
      ["maxConnectionsPerSession", Number.POSITIVE_INFINITY],
      ["maxConnectionsPerSession", 0],
      ["maxConnectionsPerSession", -3],
    ];
    for (const [field, value] of invalid) {
      expect(
        () => createHub(field === "maxConnections" ? { maxConnections: value } : { maxConnectionsPerSession: value }),
      ).toThrow(DomainError);
    }
  });

  it("分支切换后非玩家频道的订阅者也收到当前分支的新快照", () => {
    // console.timeline 的内容按分支查询：旧快照描述的是切换前的分支。
    // 只重发玩家快照会让控制台时间线停留在已归档分支，直到下一次世界变化。
    let branchLabel = "br-test";
    const hub = createHub({
      channelsFor: () => ["player", "console.timeline"],
      channelSnapshot: (channel) => (channel === "console.timeline" ? { branch: branchLabel } : null),
    });
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      const socket = new FakeSocket();
      hub.accept(socket, hub.issueTicket(session.sessionId).ticket);
      socket.receive({ type: "subscribe", channel: "console.timeline", fromStreamSeq: null });
      expect(lastFrame(socket, "snapshot")).toMatchObject({ data: { branch: "br-test" } });

      branchLabel = "br-restored";
      hub.applyBranchChange("br-restored");
      // 该连接只订阅了 console.timeline，因此收到一份带新分支内容的时间线快照；
      // 修复前这里不会有任何帧，订阅者会一直停留在旧分支。
      const snapshots = socket.drain().filter((frame) => frame["type"] === "snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ channel: "console.timeline", data: { branch: "br-restored" } });
    } finally {
      hub.close();
    }
  });

  it("容量拒绝先发关闭帧，兜底定时器到期后强制终止连接", () => {
    // 只用 close 会让未注册连接在半开状态下无人回收；只 terminate 则关闭帧
    // 可能来不及发出，对端看不到拒绝原因。因此先发帧、再在窗口后强制终止。
    const hub = createHub({ maxConnections: 1 });
    try {
      const first = hub.login({ token: "player-login-token", auth: playerAuth });
      openStream(hub, first.sessionId).drain();

      const rejected = new FakeSocket();
      vi.useFakeTimers();
      try {
        hub.accept(rejected, hub.issueTicket(first.sessionId).ticket);
        // 关闭帧已发出，对端能读到拒绝码。
        expect(rejected.closed?.code).toBe(1013);
        // 刷出窗口内尚未强制终止。
        expect(rejected.terminateCount).toBe(0);
        vi.advanceTimersByTime(2_000);
        // 到期后强制终止，未注册连接不会一直占着底层 socket。
        expect(rejected.terminateCount).toBeGreaterThan(0);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      hub.close();
    }
  });

  it("单会话连接数超限时拒绝新连接且不留下计数泄漏", () => {
    // 同一会话可反复换取票据建立连接：每次都是一次性票据，但签发不设频率限制。
    // 没有上限时每条连接都既占内存又抬高推送扇出，且会话计数只增不减。
    const hub = createHub({ maxConnectionsPerSession: 2 });
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      const first = openStream(hub, session.sessionId);
      const second = openStream(hub, session.sessionId);
      first.drain();
      second.drain();
      expect(hub.stats().connections).toBe(2);

      const rejected = new FakeSocket();
      hub.accept(rejected, hub.issueTicket(session.sessionId).ticket);
      // 超限连接在注册监听与计数之前就被关闭，因此既没有 hello 也没有订阅。
      expect(rejected.drain()).toEqual([]);
      expect(rejected.closed?.code).toBe(1013);
      // 强制终止由兜底定时器完成，不在拒绝当次同步发生。
      expect(hub.stats().connections).toBe(2);

      // 关闭一条后腾出名额，新连接可以建立，说明计数没有泄漏成永久占位。
      first.close(1000, "normal closure");
      expect(hub.stats().connections).toBe(1);
      const replacement = openStream(hub, session.sessionId);
      expect(lastFrame(replacement, "snapshot")).toMatchObject({ type: "snapshot" });
      expect(hub.stats().connections).toBe(2);
    } finally {
      hub.close();
    }
  });

  it("全局连接数超限时拒绝新连接，跨会话同样生效", () => {
    const hub = createHub({ maxConnections: 2 });
    try {
      const first = hub.login({ token: "player-login-token", auth: playerAuth });
      const second = hub.login({ token: "player-login-token", auth: playerAuth });
      const third = hub.login({ token: "player-login-token", auth: playerAuth });
      openStream(hub, first.sessionId).drain();
      openStream(hub, second.sessionId).drain();
      expect(hub.stats().connections).toBe(2);

      const rejected = new FakeSocket();
      hub.accept(rejected, hub.issueTicket(third.sessionId).ticket);
      expect(rejected.closed?.code).toBe(1013);
      expect(hub.stats().connections).toBe(2);
    } finally {
      hub.close();
    }
  });

  it("会话满容量时保留活跃连接并以明确错误拒绝新会话", () => {    const hub = createHub({ maxSessions: 1 });
    try {
      const active = hub.login({ token: "player-login-token", auth: playerAuth });
      const socket = openStream(hub, active.sessionId);
      socket.drain();

      let failure: unknown;
      try {
        hub.login({ token: "player-login-token", auth: playerAuth });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).code).toBe("budget-exhausted");
      expect((failure as DomainError).retryable).toBe(true);

      // 活跃会话不被驱逐：连接仍在线、令牌仍有效、仍能收到推送。
      expect(socket.closed).toBeNull();
      expect(hub.authenticate(active.token)).not.toBeNull();
      expect(hub.stats()).toMatchObject({ sessions: 1, connections: 1 });
      hub.publish();
      expect(lastFrame(socket, "delta")).toMatchObject({ type: "delta" });
    } finally {
      hub.close();
    }
  });

  it("容量满时淘汰无活动连接中最早过期的会话，不驱逐活跃会话", () => {
    let now = 0;
    const hub = createHub({ now: () => now, maxSessions: 2, sweepIntervalMs: 100_000 });
    try {
      // 活跃会话的过期时间更早，但它持有连接；淘汰只能选择无连接、稍晚过期的会话。
      const active = hub.login({ token: "player-login-token", auth: playerAuth });
      now += 60_000;
      const idle = hub.login({ token: "player-login-token", auth: playerAuth });
      const socket = openStream(hub, active.sessionId);
      socket.drain();

      now += 60_000;
      const replacement = hub.login({ token: "player-login-token", auth: playerAuth });
      expect(hub.authenticate(idle.token)).toBeNull();
      expect(hub.authenticate(active.token)).not.toBeNull();
      expect(hub.authenticate(replacement.token)).not.toBeNull();
      expect(socket.closed).toBeNull();
      expect(hub.stats()).toMatchObject({ sessions: 2, connections: 1 });
    } finally {
      hub.close();
    }
  });

  it("容量满时先清理过期会话再接纳新会话", () => {
    let now = 0;
    const hub = createHub({ now: () => now, maxSessions: 1, sessionTtlMs: 100 });
    try {
      const expired = hub.login({ token: "player-login-token", auth: playerAuth });
      now = 101;
      const fresh = hub.login({ token: "player-login-token", auth: playerAuth });
      expect(hub.authenticate(expired.token)).toBeNull();
      expect(hub.authenticate(fresh.token)).not.toBeNull();
      expect(hub.stats().sessions).toBe(1);
    } finally {
      hub.close();
    }
  });

  it("等长错误令牌不认证也不注销原会话，票据保持一次性消费", () => {    const hub = createHub();
    try {
      const session = hub.login({ token: "player-login-token", auth: playerAuth });
      // 等长但内容不同：查找命中摘要候选后由常量时间比较拒绝。
      const tampered = `${session.token.slice(0, -1)}${session.token.endsWith("0") ? "1" : "0"}`;
      expect(tampered).toHaveLength(session.token.length);
      expect(hub.authenticate(tampered)).toBeNull();

      // 用错误令牌注销是幂等的，不会撤销真实会话。
      hub.logout(tampered);
      expect(hub.authenticate(session.token)).not.toBeNull();

      // 票据只消费一次：第一次握手成功，第二次同一票据被拒绝。
      const ticket = hub.issueTicket(session.sessionId).ticket;
      const accepted = new FakeSocket();
      hub.accept(accepted, ticket);
      expect(accepted.closed).toBeNull();
      const reused = new FakeSocket();
      hub.accept(reused, ticket);
      // 重复消费是票据问题，不是会话失效：客户端据此重新申请票据而不是登出。
      expect(reused.closed?.code).toBe(4408);
    } finally {
      hub.close();
    }
  });

  it("票据失效与会话失效使用不同关闭码，客户端据此区分重连与登出", () => {
    // 票据过期：会话本身仍有效，客户端应重新申请票据而不是清除会话令牌。
    let ticketNow = 0;
    const ticketHub = createHub({ now: () => ticketNow, ticketTtlMs: 1_000, sessionTtlMs: 60_000 });
    try {
      const session = ticketHub.login({ token: "player-login-token", auth: playerAuth });
      const staleTicket = ticketHub.issueTicket(session.sessionId).ticket;
      ticketNow += 1_001;
      const staleSocket = new FakeSocket();
      ticketHub.accept(staleSocket, staleTicket);
      expect(staleSocket.closed?.code).toBe(4408);
      // 会话没有被票据失败牵连。
      expect(ticketHub.authenticate(session.token)).not.toBeNull();
    } finally {
      ticketHub.close();
    }

    // 票据仍在有效期内，但它绑定的会话已过期：此时必须是会话失效码，客户端停止重连。
    let sessionNow = 0;
    const sessionHub = createHub({ now: () => sessionNow, ticketTtlMs: 60_000, sessionTtlMs: 1_000 });
    try {
      const session = sessionHub.login({ token: "player-login-token", auth: playerAuth });
      const liveTicket = sessionHub.issueTicket(session.sessionId).ticket;
      sessionNow += 1_001;
      // 未经 sweep 的过期会话依然不得凭票据建立连接。
      const expiredSocket = new FakeSocket();
      sessionHub.accept(expiredSocket, liveTicket);
      expect(expiredSocket.closed?.code).toBe(4401);
    } finally {
      sessionHub.close();
    }
  });
});
