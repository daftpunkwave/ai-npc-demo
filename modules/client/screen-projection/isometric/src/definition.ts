/**
 * 声明等距屏幕投影模块的会话能力与空配置。
 * 依赖公共模块契约；坐标算法由动态实现提供。
 * 禁止把客户端投影结果当作服务端权威路径或位置。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const projectionModuleDefinition = defineBrowserModuleDefinition({
  id: "client.screen-projection.isometric",
  kind: "service",
  provides: "client.screen-projection",
  create: async (input) => {
    const { createProjectionModule } = await import("./plugin");
    return createProjectionModule(input);
  },
});
