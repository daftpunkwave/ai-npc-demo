/**
 * 核心职责：按心跳间隔探测连接活性，回收超时未回帧的半开连接，并向存活连接发送 ping。
 * 交互契约：只读取连接集合与各自的最近活跃时间；回收交由注入的 disconnect 回调，
 * 推送交由注入的发送器。不持有连接集合、不决定订阅、不管理会话或重放缓冲。
 * 约束与禁忌：禁止只关 socket 而不走 disconnect 回调，否则玩家连接计数不会下降；
 * 禁止用 close 等待对端回应——半开连接上那正是会永久挂住的操作。
 */
import type { Connection, StreamSocket } from "./stream-types";

/** 心跳所需的最小依赖；由流中心提供，本模块不感知会话与投影。 */
export interface HeartbeatProbeOptions {
  /** 当前连接集合；每次探测现取，不在构造时快照。 */
  readonly connections: () => Iterable<readonly [StreamSocket, Connection]>;
  /** 回收一条连接：必须完成计数递减等全部清理，而不只是关闭 socket。 */
  readonly disconnect: (socket: StreamSocket) => void;
  /** 向存活连接发送 ping。 */
  readonly ping: (socket: StreamSocket) => void;
  /** 注入时钟，便于用例精确控制超时边界。 */
  readonly now: () => number;
  /** 超过该窗口没有收到任何帧即判定为半开。 */
  readonly timeoutMs: number;
}

/**
 * 连接活性探测器。
 *
 * 半开连接不会产生 close 事件，因此只能按「最近一次收到帧」的时间反推；
 * 存活判定看是否收到过任何帧，而不是这一帧是否被业务接受——
 * 非法帧同样证明对端还在，把它当作失联证据会让合法客户端被误踢。
 */
export class HeartbeatProbe {
  private readonly options: HeartbeatProbeOptions;

  constructor(options: HeartbeatProbeOptions) {
    this.options = options;
  }

  /** 回收所有超时连接，然后向仍存活的连接发 ping。 */
  probe(): void {
    const now = this.options.now();
    // 先收集再处理：disconnect 会在遍历过程中修改连接集合。
    for (const [socket, connection] of [...this.options.connections()]) {
      if (now - connection.lastSeenAt <= this.options.timeoutMs) {
        continue;
      }
      this.options.disconnect(socket);
      try {
        socket.terminate();
      } catch {
        // 连接已不可用；计数与订阅已由 disconnect 清理，没有额外动作。
      }
    }
    for (const [socket] of [...this.options.connections()]) {
      this.options.ping(socket);
    }
  }
}
