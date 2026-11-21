/**
 * 创建世界模块实例；campaign 与规则状态都在 authority 事务内写入。
 * 依赖无状态生命周期骨架、规则贡献、端口工厂与模块创建输入。
 * 禁止在 create 阶段读取内容、时钟或初始化 campaign。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import {
  createStatelessModule,
  type GameContent,
  type GameIdFactory,
  type GamePortBindContext,
  type ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import { createWorldContributor } from "./contributor";
import { worldConfigSchema } from "./definition";
import { createWorldPort } from "./port";

/** 世界实现没有后台任务，公开端口暴露事务绑定器与规则贡献；章节长度进入端口，由协议模块触发章节评估。 */
export function createWorldModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = worldConfigSchema.parse(input.config);
  return createStatelessModule(input, {
    bind: (
      txFor: ScopedWorldTxFactory,
      content: GameContent,
      ids: GameIdFactory,
      context: GamePortBindContext,
    ) =>
      createWorldPort(txFor, content, ids, {
        chapterLengthTicks: config.chapterLengthTicks,
        // 章节计数来自协议 provider；其他消费者的世界端口不得触发评估。
        allowChapterEvaluation:
          context.callerModuleId === null || context.callerProvides.includes("game.agreements"),
      }),
    contributor: createWorldContributor(),
  });
}
