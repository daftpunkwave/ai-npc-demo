/**
 * 管理一次性票据换取的单条 WebSocket 连接、频道订阅、心跳、帧校验与断线回调。
 * 依赖公共 WS 判别联合与浏览器 WebSocket；不自动重放命令或维护第二份投影。
 * 禁止接受未通过 schema 的帧，也禁止在关闭后继续向旧连接发送订阅，更禁止确认未应用的帧；
 * 禁止把「能发出 ping」当成连接可用——半开连接照样能写，只有收到帧才能证明对端还在。
 */
import {
  DomainError,
  clientStreamMessageSchema,
  serverStreamMessageSchema,
  type ServerStreamMessage,
  type StreamChannel,
} from "@ai-npc/contracts";

/** 客户端主动 ping 的间隔；服务端以 pong 应答，用来证明发送方向仍通。 */
const clientPingIntervalMs = 20_000;

export interface StreamClientOptions {
  readonly url: string;
  readonly channel: StreamChannel;
  readonly fromStreamSeq: number | null;
  readonly onMessage: (message: ServerStreamMessage) => void;
  /** 连接建立并完成订阅后回调；调用方用它重置重连退避。 */
  readonly onOpen?: () => void;
  readonly onClose?: (event: CloseEvent) => void;
  readonly onError?: (error: unknown) => void;
  /**
   * 判定该帧是否已被真正应用；返回 false 时不推进游标、不发送 ack。
   * 消费方以「返回结果」而非「抛错」表示未应用的情形（例如检测到序号缺口需要重取快照），
   * 必须通过它显式声明，否则未应用的帧会被确认，重连时该增量永久丢失。
   */
  readonly isFrameApplied?: (message: ServerStreamMessage) => boolean;
  /**
   * 帧已通过传输层 schema、但被消费侧拒绝时回调（领域校验失败、应用抛错）。
   * 此时游标不推进；调用方应据此重新取快照或重连，而不是把该帧当作已应用。
   */
  readonly onFrameRejected?: (error: unknown) => void;
  /**
   * 活跃判定窗口：超过该时长没有收到任何服务端帧即主动关闭当前连接。
   * 半开连接不会触发 `close` 事件，界面会停在「已连接」却永远收不到增量，
   * 因此必须由这一计时器把连接推回既有的退避重连路径。缺省 60 秒。
   */
  readonly livenessTimeoutMs?: number;
}

/** 一条受控 WebSocket 订阅；调用方负责在组件或模块卸载时 close。 */
export class StreamClient {
  private socket: WebSocket;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAcknowledged: number | null;
  private closed = false;
  /**
   * 出现未应用的帧后置位：此后的增量一律不确认，直到收到完整快照重建连续状态。
   * 否则后续帧会把游标推过缺口，服务端重连时从缺口之后续传，缺失的增量再也不会补发。
   */
  private awaitingSnapshot = false;
  /** 是否已上报过关闭；活跃性超时会先合成一次，避免同一断线被重复上报。 */
  private closeNotified = false;

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
      }, clientPingIntervalMs);
      this.armLivenessTimer(options);
      options.onOpen?.();
    });
    this.socket.addEventListener("message", (event) => {
      // 收到任意帧都说明对端仍在，先把活跃窗口重新计时。
      // 这一步必须在 schema 校验之前：即使这一帧内容非法，连接本身仍是活的。
      this.armLivenessTimer(options);
      let message: ServerStreamMessage;
      try {
        const raw: unknown = JSON.parse(String(event.data));
        const parsed = serverStreamMessageSchema.safeParse(raw);
        if (!parsed.success) {
          throw new DomainError("validation", "WebSocket 帧不符合协议");
        }
        message = parsed.data;
      } catch (error) {
        // 传输层就拒绝的帧不改变游标，也没有可确认的 streamSeq。
        options.onError?.(error);
        return;
      }
      if (message.type === "ping") {
        // 服务端心跳：回 pong 证明本端仍在收。对端靠这个回执判定本连接是否半开，
        // 不回就等于让服务端在超时后把连接判死。
        this.send({ type: "pong" });
        return;
      }
      const isSnapshot = message.type === "snapshot";
      // 只有完整快照能重建连续状态，缺口期间到达的快照允许重新对齐游标。
      if (this.awaitingSnapshot && !isSnapshot) {
        this.rejectFrame(options, new DomainError("invalid-state", "等待快照补齐期间不接受增量"));
        return;
      }
      let applied: boolean;
      try {
        // 先交给消费方应用，成功之后才推进游标并确认。
        // 传输层 schema 只校验帧是合法 JSON，领域 schema 更严；若先推进游标，
        // 消费侧拒绝的帧会被 ack 掉，重连时服务端从已前移的序号续传，该增量永久丢失。
        options.onMessage(message);
        applied = options.isFrameApplied?.(message) ?? true;
      } catch (error) {
        this.awaitingSnapshot = true;
        this.rejectFrame(options, error);
        return;
      }
      if (!applied) {
        this.awaitingSnapshot = true;
        this.rejectFrame(options, new DomainError("invalid-state", "帧未被消费方应用"));
        return;
      }
      if (isSnapshot) {
        this.awaitingSnapshot = false;
      }
      if (message.type === "snapshot" || message.type === "delta" || message.type === "append") {
        this.lastAcknowledged = message.streamSeq;
        try {
          this.send({ type: "ack", channel: message.channel, streamSeq: message.streamSeq });
        } catch (error) {
          options.onError?.(error);
        }
      }
    });
    this.socket.addEventListener("error", (event) => {
      options.onError?.(event);
    });
    this.socket.addEventListener("close", (event) => {
      this.clearTimer();
      // 活跃性超时已经合成过一次关闭通知；真实关闭事件随后到达时不再重复上报，
      // 否则调用方会把同一次断线当成两次，退避计数被多推一轮。
      if (this.closeNotified) {
        return;
      }
      this.closeNotified = true;
      options.onClose?.(event);
    });
  }

  /**
   * 重新计时活跃窗口。超时说明连接已半开：主动关闭当前连接，
   * 让既有的 `onClose` 路径按断线处理并进入恢复退避。
   *
   * 半开连接上 `socket.close()` 可能等不到对端的关闭帧，因此这里同时合成一次关闭通知，
   * 不等底层事件：重连不能被一个已经失效的 socket 拖住。
   */
  private armLivenessTimer(options: StreamClientOptions): void {
    if (this.closed) {
      return;
    }
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
    }
    const timeoutMs = options.livenessTimeoutMs ?? 60_000;
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.clearTimer();
      try {
        this.socket.close(1000, "connection unresponsive");
      } catch {
        // 底层实现已不可用；关闭通知照常上报。
      }
      if (this.closeNotified) {
        return;
      }
      this.closeNotified = true;
      options.onClose?.({ code: 1000, reason: "connection unresponsive" } as CloseEvent);
    }, timeoutMs);
  }

  /** 未应用或被拒的帧：优先交专用回调，未提供时回退到 onError，避免错误被静默吞掉。 */
  private rejectFrame(options: StreamClientOptions, error: unknown): void {
    if (options.onFrameRejected === undefined) {
      options.onError?.(error);
      return;
    }
    options.onFrameRejected(error);
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
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }
}
