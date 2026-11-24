/**
 * 将授权投影中的提醒显示为可关闭通知，并只保留最近三条。
 * 依赖世界视图、提醒稳定键与 React 本地展示状态；不改变提醒事实或通知计数。
 * 禁止根据客户端时间推断新的紧急事件，也禁止用 tick 或下标冒充提醒身份。
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePortSubscription, type BrowserViewPort } from "@ai-npc/client-sdk";
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import type { ProjectionState } from "@ai-npc/client-protocol";
import { dismissNotification, pruneDismissed, visibleNotifications } from "./notification-state";

function NotificationsView(): ReactNode {
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const notifications = state?.projection.notifications ?? [];
  useEffect(() => {
    setDismissed((current) => pruneDismissed(current, notifications));
  }, [notifications]);
  const visible = visibleNotifications(notifications, dismissed);
  if (visible.length === 0) {
    return null;
  }
  return (
    <div className="notification-stack" aria-live="polite">
      {visible.map((notification) => (
        <article className={`notification notification-${notification.kind}`} key={notification.occurrenceKey}>
          <span>{notification.kind === "urgent" ? "紧急" : notification.kind === "deadline" ? "期限" : "提醒"}</span>
          <p>{notification.text}</p>
          <button
            type="button"
            aria-label="关闭通知"
            onClick={() => setDismissed((current) => dismissNotification(current, notification.key))}
          >
            ×
          </button>
        </article>
      ))}
    </div>
  );
}

export function createNotificationsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = { renderContribution: () => <NotificationsView /> };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
