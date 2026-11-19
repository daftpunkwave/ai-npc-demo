/**
 * 流中心的公共类型与纯辅助函数：socket 最小视图、会话/票据/连接结构、频道常量与投影增量计算。
 * 依赖公共契约的投影与消息类型；不持有可变状态、不发送消息。
 * 禁止在这里引入 Fastify、读写会话存储或按连接做 I/O。
 */
import type {
  AuthContext,
  ConversationLine,
  Json,
  PlayerNotificationView,
  PlayerProjection,
  StreamChannel,
} from "@ai-npc/contracts";

/** 推送目标的最小视图；Fastify/ws 的 WebSocket 满足该结构，测试可注入假实现。 */
export interface StreamSocket {
  readonly bufferedAmount: number;
  send(payload: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
}

/** 登录身份：令牌只用于 HTTP 认证，WS 握手使用一次性票据。 */
export interface StreamIdentity {
  readonly token: string;
  readonly auth: AuthContext;
}

/** 已建立的会话；auth 在返回给 HTTP 层时按当前分支刷新。 */
export interface StreamSession {
  readonly sessionId: string;
  readonly auth: AuthContext;
  readonly token: string;
  readonly expiresAt: number;
}

/** 可观测的资源计数；不暴露票据、令牌或主体内容。 */
export interface StreamStats {
  readonly sessions: number;
  readonly tickets: number;
  readonly connections: number;
  readonly replayBuffers: number;
}

/** 当前流位置；供世界视图与客户端重连对齐。 */
export interface StreamState {
  readonly branchId: string;
  readonly streamSeq: number;
  readonly projectionVersion: number;
}

/** 流中心的注入依赖与可调边界；测试可缩短清理/保留时间并调低推送阈值。 */
export interface StreamHubOptions {
  readonly projection: () => PlayerProjection;
  /** 按会话角色计算可订阅频道；准入裁决由传输层的策略端口完成。 */
  readonly channelsFor: (auth: AuthContext) => readonly StreamChannel[];
  readonly ids: (prefix: string) => string;
  readonly tokens: (kind: "session" | "ticket") => string;
  readonly now?: () => number;
  /** 玩家连接数变化通知；宿主据此启动断线自动暂停计时。 */
  readonly onPlayerConnectionsChanged?: (connected: number) => void;
  readonly onBranchChanged?: (branchId: string) => void;
  /** 推送缓冲超过该字节数时丢弃增量并等待快照；默认 1 MiB。 */
  readonly maxBufferedBytes?: number;
  /** 后台清理间隔；默认 60 秒，不做高频轮询。 */
  readonly sweepIntervalMs?: number;
  /** 无连接会话的重放缓冲保留时间；默认 5 分钟。 */
  readonly replayRetentionMs?: number;
  readonly sessionTtlMs?: number;
  readonly ticketTtlMs?: number;
  readonly maxSessions?: number;
  readonly maxTickets?: number;
  readonly maxReplayBuffers?: number;
}

/** 一条玩家投影增量；set 只含发生变化的顶层字段。 */
export interface ReplayFrame {
  readonly streamSeq: number;
  readonly projectionVersion: number;
  readonly set: Record<string, Json>;
}

/** 每个 (session, channel) 独立的有界重放缓冲，绑定分支与代次。 */
export interface ReplayBuffer {
  readonly sessionId: string;
  readonly channel: StreamChannel;
  generation: number;
  branchId: string;
  readonly frames: ReplayFrame[];
  lastActiveAt: number;
}

/** 已握手连接；只有订阅集合内的频道才接收推送。 */
export interface Connection {
  readonly socket: StreamSocket;
  readonly sessionId: string;
  readonly isPlayer: boolean;
  readonly subscriptions: Set<StreamChannel>;
  /** 因背压丢弃增量后置位；连接可写时补发完整快照。 */
  needsSnapshot: boolean;
}

/** 一次性 WS 票据，只记录绑定的会话与失效时间。 */
export interface StreamTicket {
  readonly sessionId: string;
  readonly expiresAt: number;
}

/** 玩家频道是当前唯一带投影快照的频道；其余频道只接收增量事件。 */
export const playerChannel: StreamChannel = "player";
/** 每个重放缓冲保留的增量条数上限；超出后客户端由快照恢复。 */
export const replayLimit = 200;
export const defaultMaxBufferedBytes = 1024 * 1024;
export const defaultSweepIntervalMs = 60_000;
export const defaultReplayRetentionMs = 5 * 60_000;
export const defaultSessionTtlMs = 12 * 60 * 60 * 1000;
export const defaultTicketTtlMs = 30_000;
export const defaultMaxSessions = 1024;
export const defaultMaxTickets = 1024;
export const defaultMaxReplayBuffers = 512;

/** 提醒的稳定键；派生提醒的 worldTick 会随 tick 重算，不参与同一提醒的识别。 */
export function notificationKey(item: PlayerNotificationView): string {
  return `${item.kind}\u0000${item.text}`;
}

/** 上次发布后新增的对白与提醒；对白按 dialogueId 去重，提醒按稳定键做多重集差。 */
export interface AppendedItem {
  readonly kind: "dialogue" | "notification";
  readonly item: ConversationLine | PlayerNotificationView;
}

/**
 * 找出上次发布后新增的对白与提醒。
 * 提醒按稳定键做多重集差，避免同一持续状态在每个 tick 重复推送。
 */
export function appendedItems(previous: PlayerProjection, next: PlayerProjection): readonly AppendedItem[] {
  const known = new Set(previous.conversations.map((line) => line.dialogueId));
  const items: AppendedItem[] = [];
  for (const line of next.conversations) {
    if (known.has(line.dialogueId)) {
      continue;
    }
    items.push({ kind: "dialogue", item: line });
  }
  const previousCounts = new Map<string, number>();
  for (const notification of previous.notifications) {
    const key = notificationKey(notification);
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  }
  const groups = new Map<string, PlayerNotificationView[]>();
  for (const notification of next.notifications) {
    const key = notificationKey(notification);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [notification]);
    } else {
      group.push(notification);
    }
  }
  for (const [key, group] of groups) {
    const added = group.length - (previousCounts.get(key) ?? 0);
    if (added <= 0) {
      continue;
    }
    for (const notification of group.slice(group.length - added)) {
      items.push({ kind: "notification", item: notification });
    }
  }
  return items;
}

/**
 * 逐顶层字段比较序列化文本；引用相同则复用基线文本，避免递归深比较。
 * 返回发生变化的字段与新的字段文本基线，调用方自行保存基线。
 */
export function changedFields(
  previous: PlayerProjection | null,
  previousTexts: ReadonlyMap<string, string> | null,
  projection: PlayerProjection,
): { readonly set: Record<string, Json>; readonly texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const changed: Record<string, Json> = {};
  const values = projection as unknown as Record<string, Json>;
  for (const [key, value] of Object.entries(values)) {
    const previousText = previousTexts?.get(key);
    if (previous !== null && previousText !== undefined) {
      const previousValue = (previous as unknown as Record<string, Json>)[key];
      if (Object.is(previousValue, value)) {
        texts.set(key, previousText);
        continue;
      }
    }
    const text = JSON.stringify(value);
    texts.set(key, text);
    if (previousText !== text) {
      changed[key] = value;
    }
  }
  return { set: changed, texts };
}

/** 全部顶层字段的序列化文本；用于建立增量比较基线。 */
export function fieldTexts(projection: PlayerProjection): Map<string, string> {
  const texts = new Map<string, string>();
  for (const [key, value] of Object.entries(projection)) {
    texts.set(key, JSON.stringify(value));
  }
  return texts;
}

/** 已填默认值的流中心边界；缺省值集中在这里，调用方只覆盖需要的项。 */
export interface HubLimits {
  readonly maxBufferedBytes: number;
  readonly sweepIntervalMs: number;
  readonly replayRetentionMs: number;
  readonly sessionTtlMs: number;
  readonly ticketTtlMs: number;
  readonly maxSessions: number;
  readonly maxTickets: number;
  readonly maxReplayBuffers: number;
}

/** 合并调用方覆盖与缺省边界；不读取配置或环境变量。 */
export function hubLimits(options: StreamHubOptions): HubLimits {
  return {
    maxBufferedBytes: options.maxBufferedBytes ?? defaultMaxBufferedBytes,
    sweepIntervalMs: options.sweepIntervalMs ?? defaultSweepIntervalMs,
    replayRetentionMs: options.replayRetentionMs ?? defaultReplayRetentionMs,
    sessionTtlMs: options.sessionTtlMs ?? defaultSessionTtlMs,
    ticketTtlMs: options.ticketTtlMs ?? defaultTicketTtlMs,
    maxSessions: options.maxSessions ?? defaultMaxSessions,
    maxTickets: options.maxTickets ?? defaultMaxTickets,
    maxReplayBuffers: options.maxReplayBuffers ?? defaultMaxReplayBuffers,
  };
}
