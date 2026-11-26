/**
 * 合并玩家授权投影快照与顶层增量，检测分支、序号缺口并触发重新取快照。
 * 依赖公共投影与 WS 帧 schema；不生成世界事实或自行推断缺失字段。
 * 禁止在游标缺口时继续套用旧增量，也禁止把私有 Agent 数据写入玩家状态。
 */
import {
  DomainError,
  playerProjectionSchema,
  type PlayerProjection,
  type StreamAppendMessage,
  type StreamDeltaMessage,
  type StreamSnapshotMessage,
} from "@world-prism/contracts";

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

/**
 * 增量补丁的校验 schema。
 * `ZodObject.partial()` 每次调用都会新建一个 schema 对象，而 applyDelta 处在每条增量帧的路径上，
 * 因此只在模块初始化时构建一次。partial 保留 strict，未知顶层字段仍被拒绝。
 * 注意 partial 也接受显式 `undefined`，那会覆盖必填字段，因此 applyDelta 另外剔除这类键。
 */
const projectionPatchSchema = playerProjectionSchema.partial();

/** 剔除值为 `undefined` 的键：它们会在合并时覆盖已通过校验的必填字段。 */
function definedPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      kept[key] = value;
    }
  }
  return kept;
}

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

  /**
   * 应用玩家投影快照。
   * 分支身份取自快照帧本身：恢复或重开后在线分支会变，服务端重发的快照携带新身份，
   * 客户端据此更新本地世界与分支，而不是沿用登录时写入的常量。
   * 跨分支快照不受「序号必须前进」约束——新分支的流序号从 0 重新计数。
   */
  applySnapshot(message: StreamSnapshotMessage): ProjectionApplyResult {
    if (message.channel !== "player" || !("projectionVersion" in message)) {
      throw new DomainError("validation", "玩家投影不能应用非 player 频道快照");
    }
    const projection = playerProjectionSchema.parse(message.data);
    const next: ProjectionState = {
      worldId: message.worldId,
      branchId: message.branchId,
      streamSeq: message.streamSeq,
      projectionVersion: message.projectionVersion,
      projection,
    };
    return this.commitSnapshot(next);
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
    // 只校验本次新增的补丁：基线投影在写入状态时已通过完整校验，补丁顶层字段又被 strict partial
    // 逐字段按完整 schema 校验，两者合并后不可能产生非法投影，因此不再对合并结果重复全量校验。
    // 显式 `undefined` 会被 partial 接受却覆盖必填字段，合并前先剔除。
    const changed = definedPatch(projectionPatchSchema.parse(message.set));
    const projection: PlayerProjection = { ...current.projection, ...changed };
    const next: ProjectionState = {
      ...current,
      streamSeq: message.streamSeq,
      projectionVersion: message.projectionVersion,
      projection,
    };
    return this.commit(next);
  }

  applyAppend(message: StreamAppendMessage): ProjectionApplyResult {
    if (message.channel !== "player" || this.state === null || this.snapshotRequired) {
      return { state: this.state, needsSnapshot: this.snapshotRequired, changed: false };
    }
    const current = this.state;
    // append 帧已是按 kind 判别的联合：item 的类型由契约绑定，无需在此重新解析。
    // 但调用方仍持有该对象，浅拷贝一次再入库，避免事后改动绕过校验与订阅通知。
    if (message.kind === "dialogue") {
      const line = { ...message.item };
      if (current.projection.conversations.some((candidate) => candidate.dialogueId === line.dialogueId)) {
        return { state: current, needsSnapshot: false, changed: false };
      }
      const projection = {
        ...current.projection,
        conversations: [...current.projection.conversations, line],
      };
      const next: ProjectionState = { ...current, projection };
      return this.commit(next);
    }
    const notification = { ...message.item };
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
    return this.commit(next);
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
    return this.commitSnapshot(next);
  }

  clear(): void {
    this.state = null;
    this.snapshotRequired = true;
    this.emit();
  }

  private commitSnapshot(next: ProjectionState): ProjectionApplyResult {
    const current = this.state;
    if (current === null) {
      return this.commit(next);
    }
    const sameBranch = current.worldId === next.worldId && current.branchId === next.branchId;
    // 跨分支快照（恢复或重开后的新在线分支）直接接受：新分支的流序号重新计数，
    // 用旧分支的序号比较会把权威快照误判成迟到帧。世界 ID 不同则是另一个世界，仍拒绝。
    if (current.worldId !== next.worldId) {
      return { state: current, needsSnapshot: this.snapshotRequired, changed: false };
    }
    if (
      sameBranch &&
      (next.streamSeq < current.streamSeq ||
        (next.streamSeq === current.streamSeq &&
          next.projectionVersion < current.projectionVersion))
    ) {
      return {
        state: current,
        needsSnapshot: this.snapshotRequired,
        changed: false,
      };
    }
    return this.commit(next);
  }

  private commit(next: ProjectionState): ProjectionApplyResult {
    this.state = next;
    this.snapshotRequired = false;
    this.emit();
    return { state: next, needsSnapshot: false, changed: true };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener(this.state);
    }
  }
}
