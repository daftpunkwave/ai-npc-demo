/**
 * 注册资源模块的 campaign 后续钩子，在开局事务内写入全部库存初始值。
 * 依赖资源端口、内容索引与 authority 处理器上下文。
 * 禁止在这里发放资源事件之外的世界状态，也禁止覆盖已有库存。
 */
import {
  gameModuleIds,
  requireGameContent,
  type GameModulePorts,
  type GameRuleContributor,
} from "@world-prism/module-sdk";
import { resourcesOwnedAggregates } from "./definition";

/** 资源模块在 campaign.start 后初始化库存；不产生额外的公开事件。 */
export function createResourcesContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: gameModuleIds.resources,
    ownsAggregates: resourcesOwnedAggregates,
    afterCommands: [
      {
        type: "campaign.start",
        hook: (context) => {
          const ports = context.modules as GameModulePorts;
          ports["game.resources"].initializeCampaign(requireGameContent(context.content));
          return { kind: "accepted" };
        },
      },
    ],
  };
}
