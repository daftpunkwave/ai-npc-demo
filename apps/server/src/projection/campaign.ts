/**
 * 核心职责：从 campaign 聚合与内容开局声明构建玩家可见的战役视图。
 * 交互契约：依赖公共契约的投影视图类型与 module-sdk 的 campaign 状态；开局缺失时按派系 ID 兜底。
 * 约束与禁忌：不读取任务风险、私有记忆或领域事件流。
 */
import type { CampaignView } from "@ai-npc/contracts";
import { CampaignView as WorldCampaignView, type GameContent } from "@ai-npc/module-sdk";

export function campaignViewOf(campaign: WorldCampaignView, content: GameContent): CampaignView {
  return {
    campaignId: campaign.campaignId,
    factionId: campaign.factionId,
    factionName: content.factions.get(campaign.factionId)?.name ?? campaign.factionId,
    // 开局 schema 必填 commission 且 campaign.start 要求开局存在；兜底只防历史分支数据缺开局。
    commission: content.starts.get(campaign.factionId)?.commission ?? campaign.factionId,
    status: campaign.status,
    outcome: campaign.outcome,
    startTick: campaign.startTick,
  };
}
