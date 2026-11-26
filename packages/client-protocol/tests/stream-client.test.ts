/**
 * 核心职责：验证 StreamClient 只在消费方成功应用帧之后推进游标并确认，且被拒绝的帧保留游标。
 * 交互契约：用假 WebSocket 注入服务端帧与关闭事件；不建立真实网络连接。
 * 约束与禁忌：禁止依赖真实计时器或浏览器 WebSocket，也不得让传输层校验替代领域应用结果。
 */
import { describe, expect, it, vi } from "vitest";
import { DomainError, type ServerStreamMessage } from "@world-prism/contracts";
import { StreamClient, type StreamClientOptions } from "../src/stream-client";

type Listener = (event: { readonly data?: unknown }) => void;

/** 只实现 StreamClient 用到的 WebSocket 表面，由测试控制收发时点。 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  /** 置位后 send 抛错，用于模拟底层 socket 写入失败。 */
  failSend = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const group = this.listeners.get(type) ?? new Set<Listener>();
    group.add(listener);
    this.listeners.set(type, group);
  }

  send(payload: string): void {
    if (this.failSend) {
      throw new Error("socket 写入失败");
    }
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  serverMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: { readonly data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function snapshot(streamSeq: number): ServerStreamMessage {
  return {
    type: "snapshot",
    channel: "player",
    streamSeq,
    projectionVersion: streamSeq,
    worldId: "wld-000000000001",
    branchId: "br-000000000001",
    data: {},
  } as unknown as ServerStreamMessage;
}

function delta(streamSeq: number, set: Record<string, unknown>): ServerStreamMessage {
  return {
    type: "delta",
    channel: "player",
    streamSeq,
    projectionVersion: streamSeq,
    set,
  } as unknown as ServerStreamMessage;
}

function connect(overrides: Partial<StreamClientOptions> = {}): {
  readonly client: StreamClient;
  readonly socket: FakeWebSocket;
} {
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = new StreamClient({
    url: "ws://test/stream",
    channel: "player",
    fromStreamSeq: 0,
    onMessage: () => undefined,
    ...overrides,
  });
  const socket = FakeWebSocket.instances[0];
  if (socket === undefined) {
    throw new Error("StreamClient 未建立连接");
  }
  socket.open();
  return { client, socket };
}

/** 客户端发出的 ack 帧序号；没有 ack 时返回空数组。 */
function acknowledgedSeqs(socket: FakeWebSocket): number[] {
  return socket.sent
    .map((payload) => JSON.parse(payload) as { type: string; streamSeq?: number })
    .filter((frame) => frame.type === "ack")
    .map((frame) => frame.streamSeq ?? -1);
}

describe("StreamClient 游标确认", () => {
  it("帧应用成功后才推进游标并发送 ack", () => {
    const applied: number[] = [];
    const { client, socket } = connect({
      onMessage: (message) => {
        if (message.type === "snapshot" || message.type === "delta") {
          applied.push(message.streamSeq);
        }
      },
    });

    socket.serverMessage(snapshot(1));
    socket.serverMessage(delta(2, {}));

    expect(applied).toEqual([1, 2]);
    expect(acknowledgedSeqs(socket)).toEqual([1, 2]);
    client.close();
  });

  it("ack 发送失败时已应用的帧不被当作未应用，也不需要重取快照", () => {
    const errors: unknown[] = [];
    const rejected: unknown[] = [];
    const applied: number[] = [];
    const { client, socket } = connect({
      onMessage: (message) => {
        if (message.type === "delta") {
          applied.push(message.streamSeq);
        }
      },
      onError: (error) => errors.push(error),
      onFrameRejected: (error) => rejected.push(error),
    });
    // 模拟底层 socket 在确认帧时写入失败（对端已不可写）。
    // ack 失败只影响「通知服务端」，不改变「本帧已被应用」这一事实。
    socket.failSend = true;

    socket.serverMessage(delta(2, {}));

    expect(applied).toEqual([2]);
    expect(errors).toHaveLength(1);
    // 关键断言：应用成功的帧不能因为 ack 失败而被当成拒帧。
    expect(rejected).toHaveLength(0);

    // 也不应进入等待快照状态：后续帧照常应用并确认。
    socket.failSend = false;
    socket.serverMessage(delta(3, {}));
    expect(applied).toEqual([2, 3]);
    expect(acknowledgedSeqs(socket)).toEqual([3]);
    client.close();
  });

  it("消费侧拒绝帧时不发送 ack，游标不前进", () => {
    const rejected: unknown[] = [];
    const appliedAfterReject: number[] = [];
    const { client, socket } = connect({
      onMessage: (message) => {
        if (message.type !== "delta") {
          return;
        }
        // 只拒绝第 2 条：模拟领域 schema 比传输层更严时的具体坏帧。
        if (message.streamSeq === 2) {
          throw new DomainError("validation", "领域字段非法");
        }
        appliedAfterReject.push(message.streamSeq);
      },
      onFrameRejected: (error) => rejected.push(error),
    });

    socket.serverMessage(snapshot(1));
    // 领域 schema 更严：传输层放行，消费侧拒绝。
    socket.serverMessage(delta(2, { clock: { worldTick: "非法" } }));

    expect(acknowledgedSeqs(socket)).toEqual([1]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(DomainError);

    // 缺口未补齐前，后续增量既不应用也不确认：承认 3 就会把 2 永久跳过。
    socket.serverMessage(delta(3, {}));
    expect(appliedAfterReject).toEqual([]);
    expect(acknowledgedSeqs(socket)).toEqual([1]);

    // 完整快照重建基线后恢复确认。
    socket.serverMessage(snapshot(4));
    expect(acknowledgedSeqs(socket)).toEqual([1, 4]);
    client.close();
  });

  it("传输层就拒绝的帧不触发应用，也不改变游标", () => {
    const onMessage = vi.fn();
    const errors: unknown[] = [];
    const { client, socket } = connect({
      onMessage,
      onError: (error) => errors.push(error),
    });

    socket.serverMessage({ type: "snapshot", channel: "player" });

    expect(onMessage).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(acknowledgedSeqs(socket)).toEqual([]);
    client.close();
  });

  it("应用失败的帧不会让重连从被跳过的序号续传", () => {
    const applied: number[] = [];
    const { client, socket } = connect({
      fromStreamSeq: 1,
      onMessage: (message) => {
        if (message.type !== "delta") {
          return;
        }
        if (message.streamSeq === 2) {
          throw new DomainError("validation", "增量非法");
        }
        applied.push(message.streamSeq);
      },
      onFrameRejected: () => undefined,
    });

    socket.serverMessage(delta(2, { tasks: [] }));
    // 游标停在 1，因此重连时的 fromStreamSeq 仍是 1，服务端会重新补发第 2 条。
    socket.serverMessage(delta(3, { tasks: [] }));

    // 缺口未被快照补齐前，第 3 条同样不应用：只确认 3 会让 2 永久丢失。
    expect(applied).toEqual([]);
    expect(acknowledgedSeqs(socket)).toEqual([]);

    // 快照重建基线后，后续增量重新按连续序号应用与确认。
    socket.serverMessage(snapshot(5));
    socket.serverMessage(delta(6, { tasks: [] }));
    expect(applied).toEqual([6]);
    expect(acknowledgedSeqs(socket)).toEqual([5, 6]);
    client.close();
  });

  it("消费方声明帧未应用时不确认，缺口不会被后续帧跨过", () => {
    // 缺口语义：store 以返回值表示「本帧没有应用」，而它不抛错。
    // 若把这种返回当作成功，ack 会跨过未应用的帧，重连时该增量永久丢失。
    const rejected: unknown[] = [];
    const { client, socket } = connect({
      fromStreamSeq: 1,
      onMessage: () => undefined,
      isFrameApplied: (message) =>
        message.type === "delta" ? message.streamSeq !== 2 : true,
      onFrameRejected: (error) => rejected.push(error),
      onError: () => undefined,
    });

    socket.serverMessage(delta(2, {}));
    expect(acknowledgedSeqs(socket)).toEqual([]);
    expect(rejected).toHaveLength(1);

    // 缺口帧未确认后，后续增量一律不再确认，直到快照重建连续状态。
    socket.serverMessage(delta(3, {}));
    expect(acknowledgedSeqs(socket)).toEqual([]);

    // 快照允许重新对齐游标：它是重建基线的唯一合法帧。
    socket.serverMessage(snapshot(9));
    expect(acknowledgedSeqs(socket)).toEqual([9]);
    client.close();
  });

  it("未提供 onFrameRejected 时把拒帧错误回退给 onError", () => {
    const errors: unknown[] = [];
    const { client, socket } = connect({
      onMessage: () => {
        throw new DomainError("validation", "领域字段非法");
      },
      onError: (error) => errors.push(error),
    });

    socket.serverMessage(delta(2, {}));

    // 没有专门的拒帧回调时不能静默吞掉错误。
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DomainError);
    expect(acknowledgedSeqs(socket)).toEqual([]);
    client.close();
  });
});
