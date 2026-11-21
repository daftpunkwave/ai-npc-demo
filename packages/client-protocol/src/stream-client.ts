/**
 * 管理一次性票据换取的单条 WebSocket 连接、频道订阅、心跳、帧校验与断线回调。
 * 依赖公共 WS 判别联合与浏览器 WebSocket；不自动重放命令或维护第二份投影。
 * 禁止接受未通过 schema 的帧，也禁止在关闭后继续向旧连接发送订阅。
 */
import {
  DomainError,
  clientStreamMessageSchema,
  serverStreamMessageSchema,
  type ServerStreamMessage,
  type StreamChannel,
} from "@ai-npc/contracts";

export interface StreamClientOptions {
  readonly url: string;
  readonly channel: StreamChannel;
  readonly fromStreamSeq: number | null;
  readonly onMessage: (message: ServerStreamMessage) => void;
  /** 连接建立并完成订阅后回调；调用方用它重置重连退避。 */
  readonly onOpen?: () => void;
  readonly onClose?: (event: CloseEvent) => void;
  readonly onError?: (error: unknown) => void;
}

/** 一条受控 WebSocket 订阅；调用方负责在组件或模块卸载时 close。 */
export class StreamClient {
  private socket: WebSocket;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastAcknowledged: number | null;
  private closed = false;

  constructor(options: StreamClientOptions) {
    this.lastAcknowledged = options.fromStreamSeq;
    this.socket = new WebSocket(options.url);
    this.socket.addEventListener("open", () => {
      this.send({
        type: "subscribe",
        channel: options.channel,
        fromStreamSeq: this.lastAcknowledged,
      });
      this.pingTimer = setInterval(() => {
        this.send({ type: "ping" });
      }, 20_000);
      options.onOpen?.();
    });
    this.socket.addEventListener("message", (event) => {
      try {
        const raw: unknown = JSON.parse(String(event.data));
        const parsed = serverStreamMessageSchema.safeParse(raw);
        if (!parsed.success) {
          throw new DomainError("validation", "WebSocket 帧不符合协议");
        }
        const message = parsed.data;
        if (
          message.type === "snapshot" ||
          message.type === "delta" ||
          message.type === "append"
        ) {
          this.lastAcknowledged = message.streamSeq;
          this.send({ type: "ack", channel: message.channel, streamSeq: message.streamSeq });
        }
        options.onMessage(message);
      } catch (error) {
        options.onError?.(error);
      }
    });
    this.socket.addEventListener("error", (event) => {
      options.onError?.(event);
    });
    this.socket.addEventListener("close", (event) => {
      this.clearTimer();
      options.onClose?.(event);
    });
  }

  send(message: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const parsed = clientStreamMessageSchema.parse(message);
    this.socket.send(JSON.stringify(parsed));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearTimer();
    this.socket.close(1000, "client closed");
  }

  private clearTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
