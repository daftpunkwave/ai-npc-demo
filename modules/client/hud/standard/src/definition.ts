/**
 * 声明标准玩家 HUD 模块，向顶部 hud slot 贡献时间、读数、资源与时钟操作。
 * 依赖玩家授权投影；不计算库存、结算或任务完成。
 * 禁止用本地按钮状态代替服务端时钟，或隐藏失败并伪造保存成功。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const hudModuleDefinition = defineBrowserModuleDefinition({
  id: "client.hud.standard",
  kind: "contributor",
  provides: "client.hud",
  requires: ["client.world-view"],
  contributions: [
    {
      extensionId: "client.hud.standard.top",
      slot: "hud",
      order: 10,
    },
  ],
  create: async (input) => {
    const { createHudModule } = await import("./plugin");
    return createHudModule(input);
  },
});
