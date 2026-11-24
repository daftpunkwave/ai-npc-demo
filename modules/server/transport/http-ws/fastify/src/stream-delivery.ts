/**
 * WS 推送出口：发送 hello/错误、按背压投递增量与快照，并在连接不可用时关闭。
 * 依赖注入的投影读取、序号读取与推送缓冲阈值；不持有连接集合、不决定订阅。
 * 禁止绕过背压阈值堆积推送、把发送异常抛给调用方，或向未确认订阅的连接补发快照。
 */
import type { Json, PlayerProjection, StreamChannel } from "@ai-npc/contracts";
import { playerChannel, type Connection, type StreamSocket } from "./stream-types";

/**
 * 拒绝连接时给关闭帧的刷出窗口。取值只需覆盖一次本地回环写入，
 * 不等待对端回应握手；到期后强制终止，保证未注册连接一定被释放。
 */
const rejectionFlushGraceMs = 1_000;

export interface SocketSenderOptions {
  readonly projection: () => PlayerProjection;
  /**
   * 快照帧要携带的分支身份。
   * 恢复或重开会切换在线分支，因此每次发快照时现取，不能缓存启动时的值；
   * 客户端据此更新本地会话身份并拒绝跨分支迟到帧。
   */
  readonly snapshotIdentity: () => { readonly worldId: string; readonly branchId: string };
  /** 控制台频道的按需快照；玩家频道仍由授权投影生成。 */
  readonly channelSnapshot?: (channel: StreamChannel) => Json | null;
  /** 非玩家频道的独立序号，避免控制台推送扰动玩家增量游标。 */
  readonly channelSequence?: (channel: StreamChannel) => number;
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

  /**
   * 发送错误帧。
   * `not-ready` 表示请求格式与授权都成立，但该频道当前没有生产者；
   * 客户端据此区分「尚未实现」与「暂无数据」，不会一直等待永不到来的帧。
   */
  sendError(socket: StreamSocket, code: "validation" | "forbidden" | "not-ready", safeMessage: string): void {
    this.sendMessage(socket, { type: "error", code, safeMessage });
  }

  /** 发送完整快照；缓冲已超阈值时保留该频道的补发标记，等连接可写后再发。 */
  sendSnapshot(connection: Connection, channel: StreamChannel): void {
    if (channel !== playerChannel) {
      let data: Json | null;
      try {
        data = this.options.channelSnapshot?.(channel) ?? null;
      } catch {
        this.close(connection.socket, 1012, "channel unavailable");
        return;
      }
      if (data === null) {
        // 该频道当前没有可推送的内容，补发标记不再有意义；保留它只会让每次 flush 重复取一次空快照。
        connection.pendingSnapshots.delete(channel);
        return;
      }
      this.sendChannelSnapshot(
        connection,
        channel,
        data,
        this.options.channelSequence?.(channel) ?? 0,
      );
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

  /** 逐频道补发积压的快照；每个频道的成功只清除它自己的标记。 */
  flushPendingSnapshot(connection: Connection): void {
    for (const channel of [...connection.pendingSnapshots]) {
      // 补发期间可能有关闭连接或新增标记的操作改变集合，逐个确认仍待补发。
      if (!connection.pendingSnapshots.has(channel)) {
        continue;
      }
      this.sendSnapshot(connection, channel);
    }
  }

  /**
   * 发送关闭帧；对端不响应关闭握手时终止底层连接。
   * 关闭帧只是请求，socket 仍会保留到握手完成或超时；容量拒绝场景下
   * 这类未注册的连接不在本中心的计数内，必须先确保它真的会被释放。
   */
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

  /**
   * 因容量拒绝连接时使用：发出关闭帧后给帧一个有界刷出机会，到期强制终止。
   * 只用 close 会让未注册的连接在半开状态下无人回收；只 terminate 则关闭帧
   * 可能来不及发出，对端看不到拒绝原因。因此两者之间留一个短窗口。
   */
  reject(socket: StreamSocket, code: number, reason: string): void {
    this.close(socket, code, reason);
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // 已经终止或不可用；拒绝动作本身已经完成。
      }
    }, rejectionFlushGraceMs);
    // 定时器只为兜底释放，不应阻止进程退出。
    timer.unref?.();
  }

  /** 用调用方已读取的投影发送快照；分支切换时避免重复读取投影。 */
  sendSnapshotPayload(connection: Connection, channel: StreamChannel, projection: PlayerProjection): void {
    const sequence = this.options.sequence();
    let payload: string;
    try {
      const identity = this.options.snapshotIdentity();
      payload = JSON.stringify({
        type: "snapshot",
        channel,
        streamSeq: sequence.streamSeq,
        projectionVersion: sequence.projectionVersion,
        worldId: identity.worldId,
        branchId: identity.branchId,
        data: projection,
      });
    } catch {
      // 投影无法序列化时连接无法重建基线；关闭后由客户端重连再试。
      this.close(connection.socket, 1012, "projection unavailable");
      connection.pendingSnapshots.add(channel);
      return;
    }
    this.sendSerializedSnapshot(connection, channel, payload);
  }

  /** 发送已序列化的快照；重同步时一份投影复用到多个连接，避免重复序列化。 */
  sendSerializedSnapshot(connection: Connection, channel: StreamChannel, payload: string): void {
    if (!this.deliver(connection, payload)) {
      connection.pendingSnapshots.add(channel);
      return;
    }
    connection.pendingSnapshots.delete(channel);
  }

  /** 发送控制台频道的完整快照；序号由该频道独立维护，分支身份同样取当前值。 */
  sendChannelSnapshot(
    connection: Connection,
    channel: StreamChannel,
    data: Json,
    streamSeq: number,
  ): void {
    let payload: string;
    try {
      const identity = this.options.snapshotIdentity();
      payload = JSON.stringify({
        type: "snapshot",
        channel,
        streamSeq,
        projectionVersion: 0,
        worldId: identity.worldId,
        branchId: identity.branchId,
        data,
      });
    } catch {
      connection.pendingSnapshots.add(channel);
      return;
    }
    this.sendSerializedSnapshot(connection, channel, payload);
  }
}
