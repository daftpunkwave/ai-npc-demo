/**
 * 声明客户端选择与输入意图模块；它只维护本地选择状态，不取用其他模块的能力端口。
 * 依赖公共模块契约；不直接发送命令或宣布游戏行动成功。
 * 禁止在描述符阶段绑定 DOM 事件或读取私有世界状态。
 */
import { defineBrowserModuleDefinition } from "@world-prism/client-sdk/define-browser-module";

export const inputModuleDefinition = defineBrowserModuleDefinition({
  id: "client.input.standard",
  kind: "service",
  provides: "client.input",
  create: async (input) => {
    const { createInputModule } = await import("./plugin");
    return createInputModule(input);
  },
});
