/**
 * 创建标准通信模块实例；没有后台任务，端口由宿主按事务绑定。
 * 依赖无状态生命周期骨架、规则贡献、端口工厂与组合根已绑定的世界只读端口。
 * 禁止在 create 阶段读取内容、生成会话或发送消息。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import {
  createStatelessModule,
  type CommsWorldFacts,
  type GameContent,
  type GameIdFactory,
  type GamePortBindContext,
  type ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import { createCommsContributor } from "./contributor";
import { createCommsPort } from "./port";

/** 从组合根已绑定的端口取世界只读视图；缺失说明依赖顺序或装配错误，直接失败。 */
function worldFactsOf(context: GamePortBindContext): CommsWorldFacts {
  const world = context.ports["game.world"];
  if (world === undefined) {
    throw new Error("通信模块缺少已声明的 game.world 端口");
  }
  return world;
}

/** 通信模块实例的公开端口同时暴露事务绑定器与规则贡献。 */
export function createCommsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, {
    bind: (
      txFor: ScopedWorldTxFactory,
      content: GameContent,
      ids: GameIdFactory,
      context: GamePortBindContext,
    ) => createCommsPort(() => txFor(input.moduleId), content, ids, worldFactsOf(context)),
    contributor: createCommsContributor(),
  });
}
