/**
 * WS 推送出口：发送 hello/错误、按背压投递增量与快照，并在连接不可用时关闭。
 * 依赖注入的投影读取、序号读取与推送缓冲阈值；不持有连接集合、不决定订阅。
 * 禁止绕过背压阈值堆积推送、把发送异常抛给调用方，或向未确认订阅的连接补发快照。
 */
import type { PlayerProjection, StreamChannel } from "@ai-npc/contracts";
import { playerChannel, type Connection, type StreamSocket } from "./stream-types";

export interface SocketSenderOptions {
  readonly projection: () => PlayerProjection;
  /** 当前流序号与投影版本；快照与增量都使用同一份。 */
  readonly sequence: () => { readonly streamSeq: number; readonly projectionVersion: number };
  /** 推送缓冲超过该字节数时丢弃增量并等待快照。 */
  readonly maxBufferedBytes: number;
}

/** 连接发送器：所有 socket 写入都经这里，统一处理背压、异常与关闭。 */
export class SocketSender {
  private readonly options: SocketSenderOptions;

  constructor(options: SocketSenderOptions) {
    this.options = options;
  }

  /** 推送前检查缓冲；超阈值不排队、不阻塞其他连接，由调用方标记需要快照。 */
  deliver(connection: Connection, payload: string): boolean {
    if (connection.socket.bufferedAmount > this.options.maxBufferedBytes) {
      return false;
    }
    try {
      connection.socket.send(payload);
      return true;
    } catch {
      this.close(connection.socket, 1012, "stream unavailable");
      return false;
    }
  }

  sendMessage(socket: StreamSocket, message: Record<string, unknown>): void {
    // hello、pong 与错误帧同样受背压约束；持续 ping 的慢连接不能绕过阈值无界堆积。
    if (socket.bufferedAmount > this.options.maxBufferedBytes) {
      this.close(socket, 1013, "backpressure");
      return;
    }
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.close(socket, 1012, "stream unavailable");
    }
  }

  sendError(socket: StreamSocket, code: "validation" | "forbidden", safeMessage: string): void {
    this.sendMessage(socket, { type: "error", code, safeMessage });
  }

  /** 发送完整快照；缓冲已超阈值时保留补发标记，等连接可写后再发。 */
  sendSnapshot(connection: Connection, channel: StreamChannel): void {
    if (channel !== playerChannel) {
      // 控制台频道没有投影快照，订阅后等待增量事件。
      return;
    }
    let projection: PlayerProjection;
    try {
      projection = this.options.projection();
    } catch {
      this.close(connection.socket, 1012, "projection unavailable");
      return;
    }
    this.sendSnapshotPayload(connection, channel, projection);
  }

  /** 连接可写且需要快照时补发一次；快照覆盖积压的所有增量。 */
  flushPendingSnapshot(connection: Connection): void {
    if (!connection.needsSnapshot || !connection.subscriptions.has(playerChannel)) {
      return;
    }
    this.sendSnapshot(connection, playerChannel);
  }

  close(socket: StreamSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      try {
        socket.terminate();
      } catch {
        // 连接已不可用；没有额外清理动作。
      }
    }
  }

  /** 用调用方已读取的投影发送快照；分支切换时避免重复读取投影。 */
  sendSnapshotPayload(connection: Connection, channel: StreamChannel, projection: PlayerProjection): void {
    const sequence = this.options.sequence();
    const payload = JSON.stringify({
      type: "snapshot",
      channel,
      streamSeq: sequence.streamSeq,
      projectionVersion: sequence.projectionVersion,
      data: projection,
    });
    if (!this.deliver(connection, payload)) {
      connection.needsSnapshot = true;
      return;
    }
    connection.needsSnapshot = false;
  }
}
