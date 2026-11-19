/**
 * 有界重放缓冲：按 (会话, 频道) 保存玩家投影增量，绑定分支与代次，负责容量淘汰与空闲清理。
 * 依赖注入时钟与“会话是否有活动连接”的查询；不发送消息、不持有连接。
 * 禁止无限保留缓冲、跨分支补发旧序号，或绕过条数上限累积增量。
 */
import {
  playerChannel,
  replayLimit,
  type ReplayBuffer,
  type ReplayFrame,
} from "./stream-types";

export interface ReplayStoreOptions {
  readonly now: () => number;
  readonly maxReplayBuffers: number;
  readonly retentionMs: number;
  /** 判断会话是否仍有活动连接；用于优先淘汰离线缓冲。 */
  readonly hasActiveConnection: (sessionId: string) => boolean;
}

/** 每个 (session, channel) 独立的有界重放缓冲集合。 */
export class ReplayStore {
  private readonly options: ReplayStoreOptions;
  private readonly buffers = new Map<string, ReplayBuffer>();
  private branchId = "";
  private generation = 0;

  constructor(options: ReplayStoreOptions) {
    this.options = options;
  }

  /** 分支切换：递增代次并清空全部缓冲，旧序号的增量不再跨分支补发。 */
  resetAll(branchId: string, generation: number): void {
    this.branchId = branchId;
    this.generation = generation;
    for (const buffer of this.buffers.values()) {
      this.reset(buffer);
    }
  }

  /** 订阅时取缓冲；跨代次或跨分支的旧缓冲就地重置。 */
  ensure(sessionId: string, channel: ReplayBuffer["channel"]): ReplayBuffer {
    const key = this.bufferKey(sessionId, channel);
    const existing = this.buffers.get(key);
    if (existing !== undefined) {
      if (existing.generation !== this.generation || existing.branchId !== this.branchId) {
        this.reset(existing);
      }
      return existing;
    }
    if (this.buffers.size >= this.options.maxReplayBuffers) {
      this.evict();
    }
    const created: ReplayBuffer = {
      sessionId,
      channel,
      generation: this.generation,
      branchId: this.branchId,
      frames: [],
      lastActiveAt: this.options.now(),
    };
    this.buffers.set(key, created);
    return created;
  }

  /** 发布一次增量：只追加到玩家频道缓冲，并保持条数上限。 */
  append(frame: ReplayFrame): void {
    for (const buffer of this.buffers.values()) {
      if (buffer.channel !== playerChannel) {
        continue;
      }
      if (buffer.generation !== this.generation || buffer.branchId !== this.branchId) {
        this.reset(buffer);
      }
      buffer.frames.push(frame);
      if (buffer.frames.length > replayLimit) {
        buffer.frames.shift();
      }
      buffer.lastActiveAt = this.options.now();
    }
  }

  /** 从游标之后的连续增量；缺口、跨代次或跨分支时返回 null，由调用方改用完整快照。 */
  select(buffer: ReplayBuffer, fromStreamSeq: number | null, streamSeq: number): readonly ReplayFrame[] | null {
    if (fromStreamSeq === null || buffer.generation !== this.generation || buffer.branchId !== this.branchId) {
      return null;
    }
    const frames = buffer.frames.filter((frame) => frame.streamSeq > fromStreamSeq);
    const first = frames.at(0);
    const last = frames.at(-1);
    if (first === undefined || last === undefined) {
      return null;
    }
    if (first.streamSeq !== fromStreamSeq + 1 || last.streamSeq !== streamSeq) {
      return null;
    }
    return frames;
  }

  /** 会话撤销或关闭时丢弃其全部缓冲。 */
  releaseSession(sessionId: string): void {
    for (const [key, buffer] of [...this.buffers]) {
      if (buffer.sessionId === sessionId) {
        this.buffers.delete(key);
      }
    }
  }

  /** 清理无连接且超过保留时间的缓冲；有活动连接的缓冲始终保留。 */
  sweep(now: number): void {
    for (const [key, buffer] of [...this.buffers]) {
      if (this.options.hasActiveConnection(buffer.sessionId)) {
        continue;
      }
      if (now - buffer.lastActiveAt <= this.options.retentionMs) {
        continue;
      }
      this.buffers.delete(key);
    }
  }

  count(): number {
    return this.buffers.size;
  }

  /** 连接断开或订阅时刷新缓冲活跃时间，避免立即被清理。 */
  touch(sessionId: string, channel: ReplayBuffer["channel"]): void {
    const buffer = this.buffers.get(this.bufferKey(sessionId, channel));
    if (buffer !== undefined) {
      buffer.lastActiveAt = this.options.now();
    }
  }

  clear(): void {
    this.buffers.clear();
  }

  private bufferKey(sessionId: string, channel: ReplayBuffer["channel"]): string {
    return `${sessionId}\u0000${channel}`;
  }

  private reset(buffer: ReplayBuffer): void {
    buffer.generation = this.generation;
    buffer.branchId = this.branchId;
    buffer.frames.length = 0;
    buffer.lastActiveAt = this.options.now();
  }

  /** 优先淘汰无活动连接的最旧缓冲；全部在用则淘汰全局最旧，客户端由快照恢复。 */
  private evict(): void {
    let victimKey: string | undefined;
    let victim: ReplayBuffer | undefined;
    for (const [key, buffer] of this.buffers) {
      if (this.options.hasActiveConnection(buffer.sessionId)) {
        continue;
      }
      if (victim === undefined || buffer.lastActiveAt < victim.lastActiveAt) {
        victimKey = key;
        victim = buffer;
      }
    }
    if (victimKey === undefined) {
      for (const [key, buffer] of this.buffers) {
        if (victim === undefined || buffer.lastActiveAt < victim.lastActiveAt) {
          victimKey = key;
          victim = buffer;
        }
      }
    }
    if (victimKey !== undefined) {
      this.buffers.delete(victimKey);
    }
  }
}
