/**
 * 核心职责：判定任务随队加成是否由执行队伍所属派系的本派支持者触发。
 * 交互契约：只读内容索引的角色派系档案与调用方给出的队伍所属派系；不读写任务或世界状态。
 * 约束与禁忌：纯查询；不在这里结算加成数值、基础值或耗时刻度，也不扩展任务类型。
 */
import type { GameContent } from "@ai-npc/module-sdk";

/** 运输运力 +5 的本派物资支持者。 */
export const transportCapacitySupporterAgentId = "npc-wenyuan";
/** 修复稳定度 +10 的本派工务支持者。 */
export const repairSupporterAgentId = "npc-taoan";
/** 救援总用时 −2 的本派医政/救援支持者。 */
export const rescueSupporterAgentId = "npc-muzhi";
/** 侦察逐路 −1 的本派情报/侦察支持者。 */
export const scoutSupporterAgentId = "npc-qilu";
/** 迁徙道路护送 +4 的本派治安/向导支持者。 */
export const escortSupporterAgentId = "npc-luchen";
/**
 * 追风：迁徙道路护送与侦察向导按设计对任何队伍同效，不限定本派。
 * 因此这两个加成保留独立判定，不要并入本派支持者校验。
 */
export const externalGuideAgentId = "species-fauna";
/**
 * 洛：非 `team-star` 修复任务的额外 +15 按任务类型固定，不限定本派。
 * 普通队伍带洛得 `25 + 15`，带本派工务支持者再叠加 +10，都是设计值。
 */
export const externalRepairSupporterAgentId = "species-extraterrestrial";

/**
 * 参与者里是否有执行队伍所属派系的支持者。
 * 任务随队加成只认本派：参与者角色档案的 `factionId` 必须与队伍所属派系一致，
 * 避免跨派邀请（例如泊星者 `team-star` 邀请公社陶安）套用本派加成。
 */
export function hasFactionSupporter(
  content: GameContent,
  ownerFactionId: string | null,
  participants: readonly string[],
  supporterAgentId: string,
): boolean {
  if (ownerFactionId === null) {
    return false;
  }
  return participants.some(
    (agentId) =>
      agentId === supporterAgentId && content.characters.get(agentId)?.factionId === ownerFactionId,
  );
}
