/**
 * 核心职责：验证连接活性探测器按最近活跃时间回收半开连接，并向存活连接发送 ping。
 * 交互契约：只使用注入的连接集合、时钟、回收回调与 ping 出口；不建立真实 socket。
 * 约束与禁忌：禁止断言定时器节拍（由流中心与用例共同控制），只断言一次探测的判定与副作用。
 */
import { describe, expect, it } from "vitest";
import { HeartbeatProbe } from "../src/heartbeat-probe";
import type { Connection, StreamSocket } from "../src/stream-types";

/** 最小连接记录：探测器只读取 lastSeenAt，其余字段不参与判定。 */
function connection(lastSeenAt: number): Connection {
  return {
    socket: {} as StreamSocket,
    sessionId: "ses-000000000001",
    isPlayer: true,
    subscriptions: new Set(),
    pendingSnapshots: new Set(),
    lastSeenAt,
  };
}

describe("连接活性探测器", () => {
  it("超时窗口内收到过帧的连接保留，并获得 ping", () => {
    const sockets: StreamSocket[] = [];
    const pings: StreamSocket[] = [];
    const live = connection(900);
    const probe = new HeartbeatProbe({
      connections: () => [[live.socket, live]],
      disconnect: () => {
        throw new Error("不应回收存活连接");
      },
      ping: (socket) => pings.push(socket),
      now: () => 1_000,
      timeoutMs: 200,
    });
    probe.probe();
    expect(sockets).toEqual([]);
    expect(pings).toEqual([live.socket]);
  });

  it("超过超时窗口未收到帧的连接被回收，且回收先于 ping", () => {
    const order: string[] = [];
    const stale = connection(100);
    const live = connection(900);
    let terminated = false;
    // replace 掉 terminate 以便断言调用；探测器对此只调用一次。
    (stale.socket as unknown as { terminate: () => void }).terminate = () => {
      terminated = true;
      order.push("terminate");
    };
    const probe = new HeartbeatProbe({
      connections: () => [
        [stale.socket, stale],
        [live.socket, live],
      ],
      disconnect: (socket) => {
        order.push(socket === stale.socket ? "disconnect:stale" : "disconnect:live");
      },
      ping: () => order.push("ping"),
      now: () => 1_000,
      timeoutMs: 200,
    });
    probe.probe();

    expect(terminated).toBe(true);
    // 回收必须走 disconnect 而不是只 terminate：玩家连接计数只由 disconnect 递减。
    expect(order.slice(0, 2)).toEqual(["disconnect:stale", "terminate"]);
    expect(order).not.toContain("disconnect:live");
  });

  it("回收后不再向已终止连接发 ping", () => {
    const stale = connection(0);
    (stale.socket as unknown as { terminate: () => void }).terminate = () => {};
    const pings: StreamSocket[] = [];
    // 连接集合在 disconnect 中被移除，因此 ping 阶段不应再看到它。
    const active = new Map<StreamSocket, Connection>([[stale.socket, stale]]);
    const probe = new HeartbeatProbe({
      connections: () => active,
      disconnect: (socket) => active.delete(socket),
      ping: (socket) => pings.push(socket),
      now: () => 10_000,
      timeoutMs: 100,
    });
    probe.probe();
    expect(pings).toEqual([]);
  });

  it("terminate 抛错不影响其余连接的回收与 ping", () => {
    const stale = connection(0);
    const live = connection(9_999);
    (stale.socket as unknown as { terminate: () => void }).terminate = () => {
      throw new Error("socket 已销毁");
    };
    const disconnected: StreamSocket[] = [];
    const pings: StreamSocket[] = [];
    // 生产实现里 disconnect 会从连接集合移除该连接，因此后续 ping 阶段不再看到它。
    const active = new Map<StreamSocket, Connection>([
      [stale.socket, stale],
      [live.socket, live],
    ]);
    const probe = new HeartbeatProbe({
      connections: () => active,
      disconnect: (socket) => {
        disconnected.push(socket);
        active.delete(socket);
      },
      ping: (socket) => pings.push(socket),
      now: () => 10_000,
      timeoutMs: 100,
    });
    expect(() => {
      probe.probe();
    }).not.toThrow();
    expect(disconnected).toEqual([stale.socket]);
    expect(pings).toEqual([live.socket]);
  });
});
