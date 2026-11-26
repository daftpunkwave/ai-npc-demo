/**
 * 声明玩家授权投影模块的会话能力、空配置与动态实现入口。
 * 依赖公共模块契约与 module-sdk；不在描述符阶段连接网络或创建投影状态。
 * 禁止让该模块持有服务端权威或绕过授权投影读取世界事实。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const worldViewModuleDefinition = defineBrowserModuleDefinition({
  id: "client.world-view.standard",
  kind: "service",
  provides: "client.world-view",
  create: async (input) => {
    const { createWorldViewModule } = await import("./plugin");
    return createWorldViewModule(input);
  },
});
