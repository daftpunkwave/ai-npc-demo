/**
 * 核心职责：验证 StreamClient 只在消费方成功应用帧之后推进游标并确认，且被拒绝的帧保留游标。
 * 交互契约：用假 WebSocket 注入服务端帧与关闭事件；不建立真实网络连接。
 * 约束与禁忌：禁止依赖真实计时器或浏览器 WebSocket，也不得让传输层校验替代领域应用结果。
 */
import { describe, expect, it, vi } from "vitest";
import { DomainError, type ServerStreamMessage } from "@ai-npc/contracts";
import { StreamClient, type StreamClientOptions } from "../src/stream-client";

type Listener = (event: { readonly data?: unknown }) => void;

/** 只实现 StreamClient 用到的 WebSocket 表面，由测试控制收发时点。 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
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

  it("消费侧拒绝帧时不发送 ack，游标不前进", () => {
    const rejected: unknown[] = [];
    const acknowledgedAfterReject: number[] = [];
    const { client, socket } = connect({
      onMessage: (message) => {
        if (message.type !== "delta") {
          return;
        }
        // 只拒绝第 2 条：模拟领域 schema 比传输层更严时的具体坏帧。
        if (message.streamSeq === 2) {
          throw new DomainError("validation", "领域字段非法");
        }
        acknowledgedAfterReject.push(message.streamSeq);
      },
      onFrameRejected: (error) => rejected.push(error),
    });

    socket.serverMessage(snapshot(1));
    // 领域 schema 更严：传输层放行，消费侧拒绝。
    socket.serverMessage(delta(2, { clock: { worldTick: "非法" } }));

    expect(acknowledgedSeqs(socket)).toEqual([1]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(DomainError);

    // 被拒绝的帧没有推进游标：后续合法帧仍按原始序号确认。
    socket.serverMessage(delta(3, {}));
    expect(acknowledgedAfterReject).toEqual([3]);
    expect(acknowledgedSeqs(socket)).toEqual([1, 3]);
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
    const rejectKinds = new Set<number>([2]);
    const applied: number[] = [];
    const { client, socket } = connect({
      fromStreamSeq: 1,
      onMessage: (message) => {
        if (message.type !== "delta") {
          return;
        }
        if (rejectKinds.has(message.streamSeq)) {
          throw new DomainError("validation", "增量非法");
        }
        applied.push(message.streamSeq);
      },
      onFrameRejected: () => undefined,
    });

    socket.serverMessage(delta(2, { tasks: [] }));
    // 游标停在 1，因此重连时的 fromStreamSeq 仍是 1，服务端会重新补发第 2 条。
    socket.serverMessage(delta(3, { tasks: [] }));

    expect(applied).toEqual([3]);
    expect(acknowledgedSeqs(socket)).toEqual([3]);
    client.close();
  });
});
