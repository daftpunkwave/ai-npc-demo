/**
 * 校验提醒稳定键与关闭状态：键不含 worldTick 或下标，关闭后在后续 tick 仍生效，集合随当前提醒收敛。
 * 依赖公共提醒视图与本模块纯函数；不挂载 React 组件或启动浏览器。
 * 禁止让同一提醒因 tick 变化重新出现，也禁止关闭集合无界增长。
 */
import { describe, expect, it } from "vitest";
import { playerNotificationKey, type PlayerNotificationView } from "@ai-npc/contracts";
import {
  dismissNotification,
  pruneDismissed,
  visibleNotifications,
} from "../src/notification-state";

function notification(
  text: string,
  worldTick: number,
  kind: PlayerNotificationView["kind"] = "deadline",
): PlayerNotificationView {
  return { kind, text, worldTick };
}

describe("playerNotificationKey", () => {
  it("同一提醒的键不随 tick 变化，不同文案或类型使用不同键", () => {
    expect(playerNotificationKey(notification("24 tick 内到期", 10))).toBe(
      playerNotificationKey(notification("24 tick 内到期", 30)),
    );
    expect(playerNotificationKey(notification("24 tick 内到期", 10))).not.toBe(
      playerNotificationKey(notification("任务失败", 10)),
    );
    expect(playerNotificationKey(notification("公共广播", 10, "public"))).not.toBe(
      playerNotificationKey(notification("公共广播", 10, "urgent")),
    );
  });
});

describe("visibleNotifications", () => {
  it("只展示最近三条并按最新在前排序", () => {
    const notifications = ["一", "二", "三", "四"].map((text, index) => notification(text, index));

    const visible = visibleNotifications(notifications, new Set());

    expect(visible.map((item) => item.text)).toEqual(["四", "三", "二"]);
  });

  it("关闭状态按稳定键生效，下一 tick 重新派生时仍然隐藏", () => {
    const first = [notification("协议即将到期", 10)];
    const dismissed = dismissNotification(new Set(), playerNotificationKey(first[0] as PlayerNotificationView));

    expect(visibleNotifications(first, dismissed)).toHaveLength(0);
    expect(visibleNotifications([notification("协议即将到期", 30)], dismissed)).toHaveLength(0);
  });

  it("同一稳定键在一次投影里只展示一次，并取最后一次的 tick", () => {
    const visible = visibleNotifications(
      [notification("公共广播", 3, "public"), notification("公共广播", 9, "public")],
      new Set(),
    );

    expect(visible).toHaveLength(1);
    expect(visible[0]?.worldTick).toBe(9);
  });
});

describe("dismissNotification", () => {
  it("重复关闭同一键时返回原集合", () => {
    const dismissed = dismissNotification(new Set(), "deadline\u0000到期");
    expect(dismissNotification(dismissed, "deadline\u0000到期")).toBe(dismissed);
  });
});

describe("pruneDismissed", () => {
  it("只保留当前投影仍存在的关闭键", () => {
    const dismissed = new Set(["deadline\u0000到期", "urgent\u0000任务失败"]);

    const pruned = pruneDismissed(dismissed, [notification("到期", 10)]);

    expect([...pruned]).toEqual(["deadline\u0000到期"]);
  });

  it("没有需要清理的键时返回原集合", () => {
    const dismissed = new Set(["deadline\u0000到期"]);

    expect(pruneDismissed(dismissed, [notification("到期", 20)])).toBe(dismissed);
    expect(pruneDismissed(new Set(), [notification("到期", 20)])).toEqual(new Set());
  });
});
