/**
 * 核心职责：把投影提醒转换成带稳定键的展示项，并维护「已关闭」集合与当前提醒的交集。
 * 交互契约：键与投影视图字段（kind + text）绑定，不包含 worldTick 或数组下标；不修改投影事实。
 * 约束与禁忌：不在客户端推断新的提醒，也不让已关闭集合随 tick 或渲染次数增长。
 */
import { playerNotificationKey, type PlayerNotificationView } from "@world-prism/contracts";

export const visibleNotificationLimit = 3;

export interface DisplayNotification {
  /** 关闭状态与服务端增量比对共用的稳定键；同一键的多条提醒共享关闭状态。 */
  readonly key: string;
  /** 仅用于列表渲染的唯一键；同一稳定键的多条提醒不合并显示。 */
  readonly occurrenceKey: string;
  readonly kind: PlayerNotificationView["kind"];
  readonly text: string;
  readonly worldTick: number;
}

/**
 * 只展示最近的若干条提醒，按数组顺序保留同一稳定键的多条实例。
 * `key` 不含 worldTick，因此同一提醒在下一 tick 重新派生时仍然沿用用户的关闭状态；
 * `occurrenceKey` 只承担渲染身份，不参与关闭语义。
 */
export function visibleNotifications(
  notifications: readonly PlayerNotificationView[],
  dismissed: ReadonlySet<string>,
  limit: number = visibleNotificationLimit,
): DisplayNotification[] {
  return notifications
    .map((notification, index) => {
      const key = playerNotificationKey(notification);
      return {
        key,
        occurrenceKey: `${key}\u0000${index}`,
        kind: notification.kind,
        text: notification.text,
        worldTick: notification.worldTick,
      };
    })
    .filter((notification) => !dismissed.has(notification.key))
    .slice(-limit)
    .reverse();
}

/** 关闭一条提醒；已关闭时返回原集合，避免无意义的重新渲染。 */
export function dismissNotification(dismissed: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (dismissed.has(key)) {
    return dismissed;
  }
  return new Set([...dismissed, key]);
}

/** 只保留仍出现在当前投影中的关闭键；提醒消失后再次出现时重新可见。 */
export function pruneDismissed(
  dismissed: ReadonlySet<string>,
  notifications: readonly PlayerNotificationView[],
): ReadonlySet<string> {
  if (dismissed.size === 0) {
    return dismissed;
  }
  const current = new Set(notifications.map((notification) => playerNotificationKey(notification)));
  const kept = new Set<string>();
  for (const key of dismissed) {
    if (current.has(key)) {
      kept.add(key);
    }
  }
  return kept.size === dismissed.size ? dismissed : kept;
}
