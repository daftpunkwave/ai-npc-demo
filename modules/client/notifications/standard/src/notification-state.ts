/**
 * 核心职责：把投影提醒转换成带稳定键的展示项，并维护「已关闭」集合与当前提醒的交集。
 * 交互契约：键与投影视图字段（kind + text）绑定，不包含 worldTick 或数组下标；不修改投影事实。
 * 约束与禁忌：不在客户端推断新的提醒，也不让已关闭集合随 tick 或渲染次数增长。
 */
import { playerNotificationKey, type PlayerNotificationView } from "@ai-npc/contracts";

export const visibleNotificationLimit = 3;

export interface DisplayNotification {
  readonly key: string;
  readonly kind: PlayerNotificationView["kind"];
  readonly text: string;
  readonly worldTick: number;
}

/**
 * 只展示最近的若干条提醒，同一稳定键只保留最后一次出现的值。
 * 键不含 worldTick，因此同一提醒在下一 tick 重新派生时仍然沿用用户的关闭状态。
 */
export function visibleNotifications(
  notifications: readonly PlayerNotificationView[],
  dismissed: ReadonlySet<string>,
  limit: number = visibleNotificationLimit,
): DisplayNotification[] {
  const byKey = new Map<string, DisplayNotification>();
  for (const notification of notifications) {
    const key = playerNotificationKey(notification);
    byKey.set(key, {
      key,
      kind: notification.kind,
      text: notification.text,
      worldTick: notification.worldTick,
    });
  }
  return [...byKey.values()]
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
