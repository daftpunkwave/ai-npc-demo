/**
 * 核心职责：从当前玩家投影计算顶层字段增量与新增对白/提醒，写入有界重放缓冲并按连接推送；
 * 投影基线失效时重建缓冲区、基线与订阅连接的快照。
 * 交互契约：由流中心注入投影来源、连接表、会话注册表、重放缓冲、发送器与可变游标/基线；
 * 本模块直接更新传入的游标与基线，但不持有它们。
 * 约束与禁忌：不在投递失败后继续补发同批增量，不在重同步失败时伪造基线，也不读取存储或会话存储。
 */
import type { PlayerProjection, StreamChannel } from "@ai-npc/contracts";
import type { ReplayStore } from "./replay-store";
import type { SessionRegistry } from "./session-registry";
import type { SocketSender } from "./stream-delivery";
import { appendedItems, changedFields, type Connection } from "./stream-types";

/** 发布所需的可变流位置；由流中心持有并逐次提交。 */
export interface ProjectionCursor {
  streamSeq: number;
  projectionVersion: number;
}

/** 增量基线：上一份投影与其各顶层字段的序列化文本。 */
export interface ProjectionBaseline {
  projection: PlayerProjection | null;
  fieldText: Map<string, string> | null;
}

/** 一次投影发布所需的全部注入依赖。 */
export interface ProjectionPublisherInput {
  readonly connections: ReadonlyMap<unknown, Connection>;
  readonly sessions: SessionRegistry;
  readonly replay: ReplayStore;
  readonly sender: SocketSender;
  readonly projection: () => PlayerProjection;
  readonly worldId: string;
  readonly branchId: () => string;
  readonly generation: () => number;
  readonly cursor: ProjectionCursor;
  readonly baseline: ProjectionBaseline;
  readonly playerChannel: StreamChannel;
}

/**
 * 发布一次玩家投影：计算顶层字段增量，记录有界重放缓冲并按连接推送。
 * 只有增量真正变化时 set 才非空；空 set 仍推进版本，供客户端识别心跳。
 */
export function publishProjection(input: ProjectionPublisherInput): void {
  const { connections, sessions, replay, sender, cursor, baseline } = input;
  const projection = input.projection();
  const appends = baseline.projection === null ? [] : appendedItems(baseline.projection, projection);
  const changed = changedFields(baseline.projection, baseline.fieldText, projection);
  baseline.projection = Object.freeze({ ...projection });
  baseline.fieldText = changed.texts;
  cursor.streamSeq += 1;
  cursor.projectionVersion += 1;
  replay.append({ streamSeq: cursor.streamSeq, projectionVersion: cursor.projectionVersion, set: changed.set });
  const channel = input.playerChannel;
  const deltaPayload = JSON.stringify({
    type: "delta",
    channel,
    streamSeq: cursor.streamSeq,
    projectionVersion: cursor.projectionVersion,
    set: changed.set,
  });
  for (const connection of [...connections.values()]) {
    if (!connection.subscriptions.has(channel)) {
      continue;
    }
    if (sessions.activeSession(connection.sessionId) === null) {
      continue;
    }
    if (connection.pendingSnapshots.has(channel)) {
      sender.flushPendingSnapshot(connection);
      if (connection.pendingSnapshots.has(channel)) {
        continue;
      }
    }
    if (!sender.deliver(connection, deltaPayload)) {
      connection.pendingSnapshots.add(channel);
      continue;
    }
    // 同一 streamSeq 的新对白/提醒按单条追加；慢连接在任一次投递失败后等快照恢复。
    for (const append of appends) {
      const appendPayload = JSON.stringify({
        type: "append",
        channel,
        streamSeq: cursor.streamSeq,
        kind: append.kind,
        item: append.item,
      });
      if (!sender.deliver(connection, appendPayload)) {
        connection.pendingSnapshots.add(channel);
        break;
      }
    }
  }
}

/**
 * 投影基线失效后的恢复：清空旧增量，按当前投影重建基线并向订阅中的玩家补发完整快照。
 * 只有真正订阅了玩家频道的连接才需要补发：仅具玩家身份但未订阅的连接
 * 不该因为一次重同步而在后续 sweep 或 ack 时收到完整投影。
 */
export function resyncProjection(
  input: ProjectionPublisherInput,
  report: (message: string, error: unknown) => void,
): void {
  const { connections, sessions, replay, sender, cursor, baseline } = input;
  const channel = input.playerChannel;
  replay.resetAll(input.branchId(), input.generation());
  const players = [...connections.values()].filter((connection) =>
    connection.isPlayer && connection.subscriptions.has(channel));
  for (const connection of players) {
    connection.pendingSnapshots.add(channel);
  }
  let projection: PlayerProjection;
  try {
    projection = input.projection();
  } catch (error) {
    report("projection resync failed", error);
    return;
  }
  let payload: string;
  try {
    payload = JSON.stringify({
      type: "snapshot",
      channel,
      streamSeq: cursor.streamSeq,
      projectionVersion: cursor.projectionVersion,
      // 一份投影复用到多个连接，但身份仍按当前在线分支现取。
      worldId: input.worldId,
      branchId: input.branchId(),
      data: projection,
    });
  } catch (error) {
    report("projection resync failed", error);
    return;
  }
  // 快照已经包含当前状态；先推进增量基线，避免下一次 publish 重复追加快照里已有的条目。
  try {
    baseline.projection = Object.freeze({ ...projection });
    baseline.fieldText = changedFields(null, null, projection).texts;
  } catch (error) {
    report("projection resync failed", error);
    return;
  }
  for (const connection of players) {
    // 过期会话可能在读取投影期间失效；activeSession 会撤销会话并关闭其连接，不能再补发快照。
    if (sessions.activeSession(connection.sessionId) === null) {
      continue;
    }
    if (!connection.subscriptions.has(channel)) {
      continue;
    }
    sender.sendSerializedSnapshot(connection, channel, payload);
  }
}
