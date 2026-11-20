/**
 * 声明标准通知模块，向 notification slot 贡献玩家授权提醒。
 * 依赖玩家投影；不把日志、错误或控制台事件当作游戏提醒。
 * 禁止用渲染器本地计时器生成世界事实。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const notificationsModuleDefinition = defineBrowserModuleDefinition({
  id: "client.notifications.standard",
  kind: "contributor",
  provides: "client.notifications",
  requires: ["client.world-view"],
  contributions: [
    {
      extensionId: "client.notifications.standard.toast",
      slot: "notification",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createNotificationsModule } = await import("./plugin");
    return createNotificationsModule(input);
  },
});
