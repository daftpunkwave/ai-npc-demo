/**
 * 核心职责：验证客户端 WS 心跳的两个方向——回应服务端 ping，以及在长时间收不到帧时主动断开半开连接。
 * 交互契约：注入假 WebSocket 与假定时器；不建立真实网络连接、不依赖真实等待。
 * 约束与禁忌：禁止把「能发出 ping」当作连接可用，也禁止让超时关闭重复上报引发多轮重连。
 */
import { describe, expect, it, vi } from "vitest";
import { StreamClient, type StreamClientOptions } from "../src/stream-client";

type Listener = (event: { readonly data?: unknown }) => void;

/** 只实现 StreamClient 用到的 WebSocket 表面；不自动回传关闭事件，由用例决定何时上报。 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  closeCall: { readonly code: number; readonly reason: string } | null = null;
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

  close(code: number, reason: string): void {
    this.closeCall = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  serverMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  emitClose(code = 1000, reason = "closed"): void {
    this.emit("close", { code, reason });
  }

  frameTypes(): string[] {
    return this.sent.map((payload) => (JSON.parse(payload) as { readonly type: string }).type);
  }

  private emit(type: string, event: Record<string, unknown>): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
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

describe("StreamClient 心跳与半开连接", () => {
  it("收到服务端 ping 时回 pong，不让服务端把本端判为失联", () => {
    const { client, socket } = connect();

    socket.serverMessage({ type: "ping" });

    expect(socket.frameTypes()).toContain("pong");
    client.close();
  });

  it("pong 回执不影响投影游标，也不触发 ack", () => {
    const applied: number[] = [];
    const { client, socket } = connect({
      onMessage: (message) => {
        if (message.type === "snapshot") {
          applied.push(message.streamSeq);
        }
      },
    });

    socket.serverMessage({
      type: "snapshot",
      channel: "player",
      streamSeq: 1,
      projectionVersion: 1,
      worldId: "wld-000000000001",
      branchId: "br-000000000001",
      data: {},
    });
    socket.serverMessage({ type: "ping" });

    // pong 是通信层回执，不进入消费方回调，也不推进投影游标。
    expect(applied).toEqual([1]);
    expect(socket.frameTypes().filter((type) => type === "ack")).toHaveLength(1);
    client.close();
  });

  it("长时间收不到任何帧时主动断开并上报一次关闭，让调用方进入重连", async () => {
    vi.useFakeTimers();
    try {
      const closes: { readonly code: number; readonly reason: string }[] = [];
      const { client } = connect({
        livenessTimeoutMs: 1_000,
        onClose: (event) => closes.push({ code: event.code, reason: event.reason }),
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(closes).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(closes).toHaveLength(1);
      expect(closes[0]?.reason).toBe("connection unresponsive");

      // 半开连接上底层关闭事件可能迟到或不来；迟到时也不能把同一次断线上报两次，
      // 否则调用方的退避计数会被多推一轮。
      FakeWebSocket.instances[0]?.emitClose(1006, "abnormal");
      expect(closes).toHaveLength(1);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("收到帧会把活跃窗口重新计时，不会因为一次长间隔被误判为半开", async () => {
    vi.useFakeTimers();
    try {
      const closes: { readonly code: number; readonly reason: string }[] = [];
      const { client, socket } = connect({
        livenessTimeoutMs: 1_000,
        onClose: (event) => closes.push({ code: event.code, reason: event.reason }),
      });

      for (let index = 0; index < 5; index += 1) {
        await vi.advanceTimersByTimeAsync(900);
        socket.serverMessage({ type: "ping" });
      }

      expect(closes).toEqual([]);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
