/**
 * 合并玩家授权投影快照与顶层增量，检测分支、序号缺口并触发重新取快照。
 * 依赖公共投影、WS 增量与对白 append schema；不生成世界事实或自行推断缺失字段。
 * 禁止在游标缺口时继续套用旧增量，也禁止把私有 Agent 数据写入玩家状态。
 */
import {
  DomainError,
  conversationLineSchema,
  playerNotificationViewSchema,
  playerProjectionSchema,
  type PlayerProjection,
  type StreamAppendMessage,
  type StreamDeltaMessage,
  type StreamSnapshotMessage,
} from "@ai-npc/contracts";

export interface ProjectionState {
  readonly worldId: string;
  readonly branchId: string;
  readonly streamSeq: number;
  readonly projectionVersion: number;
  readonly projection: PlayerProjection;
}

export interface ProjectionApplyResult {
  readonly state: ProjectionState | null;
  readonly needsSnapshot: boolean;
  readonly changed: boolean;
}

type Listener = (state: ProjectionState | null) => void;

/** 单份玩家投影的 reducer；模块共享同一实例，不能各建一套世界状态。 */
export class ProjectionStore {
  private state: ProjectionState | null = null;
  private readonly listeners = new Set<Listener>();
  private snapshotRequired = false;

  getSnapshot(): ProjectionState | null {
    return this.state;
  }

  get streamSeq(): number | null {
    return this.state?.streamSeq ?? null;
  }

  needsSnapshot(): boolean {
    return this.snapshotRequired;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  applySnapshot(
    message: StreamSnapshotMessage,
    worldId: string,
    branchId: string,
  ): ProjectionApplyResult {
    if (message.channel !== "player") {
      throw new DomainError("validation", "玩家投影不能应用非 player 频道快照");
    }
    const projection = playerProjectionSchema.parse(message.data);
    const next: ProjectionState = {
      worldId,
      branchId,
      streamSeq: message.streamSeq,
      projectionVersion: message.projectionVersion,
      projection,
    };
    this.state = next;
    this.snapshotRequired = false;
    this.emit();
    return { state: next, needsSnapshot: false, changed: true };
  }

  applyDelta(message: StreamDeltaMessage): ProjectionApplyResult {
    if (message.channel !== "player") {
      throw new DomainError("validation", "玩家投影不能应用非 player 频道增量");
    }
    const current = this.state;
    if (current === null || message.streamSeq !== current.streamSeq + 1) {
      this.snapshotRequired = true;
      return { state: current, needsSnapshot: true, changed: false };
    }
    const changed = playerProjectionSchema.partial().parse(message.set);
    const projection = playerProjectionSchema.parse({ ...current.projection, ...changed });
    const next: ProjectionState = {
      ...current,
      streamSeq: message.streamSeq,
      projectionVersion: message.projectionVersion,
      projection,
    };
    this.state = next;
    this.snapshotRequired = false;
    this.emit();
    return { state: next, needsSnapshot: false, changed: true };
  }

  applyAppend(message: StreamAppendMessage): ProjectionApplyResult {
    if (message.channel !== "player" || this.state === null) {
      return { state: this.state, needsSnapshot: false, changed: false };
    }
    const current = this.state;
    if (message.kind === "dialogue") {
      const line = conversationLineSchema.parse(message.item);
      if (current.projection.conversations.some((candidate) => candidate.dialogueId === line.dialogueId)) {
        return { state: current, needsSnapshot: false, changed: false };
      }
      const projection = {
        ...current.projection,
        conversations: [...current.projection.conversations, line],
      };
      const next: ProjectionState = { ...current, projection };
      this.state = next;
      this.emit();
      return { state: next, needsSnapshot: false, changed: true };
    }
    if (message.kind === "notification") {
      const notification = playerNotificationViewSchema.parse(message.item);
      const duplicate = current.projection.notifications.some(
        (candidate) =>
          candidate.kind === notification.kind &&
          candidate.worldTick === notification.worldTick &&
          candidate.text === notification.text,
      );
      if (duplicate) {
        return { state: current, needsSnapshot: false, changed: false };
      }
      const projection = {
        ...current.projection,
        notifications: [...current.projection.notifications, notification],
      };
      const next: ProjectionState = { ...current, projection };
      this.state = next;
      this.emit();
      return { state: next, needsSnapshot: false, changed: true };
    }
    return { state: current, needsSnapshot: false, changed: false };
  }

  replaceSnapshot(input: {
    readonly worldId: string;
    readonly branchId: string;
    readonly streamSeq: number;
    readonly projectionVersion: number;
    readonly projection: PlayerProjection;
  }): ProjectionApplyResult {
    const projection = playerProjectionSchema.parse(input.projection);
    const next: ProjectionState = {
      worldId: input.worldId,
      branchId: input.branchId,
      streamSeq: input.streamSeq,
      projectionVersion: input.projectionVersion,
      projection,
    };
    this.state = next;
    this.snapshotRequired = false;
    this.emit();
    return { state: next, needsSnapshot: false, changed: true };
  }

  clear(): void {
    this.state = null;
    this.snapshotRequired = true;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener(this.state);
    }
  }
}
