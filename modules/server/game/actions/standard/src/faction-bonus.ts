/**
 * 核心职责：按内容包章节规则参数结算任务随队加成与修复工作节点判定。
 * 交互契约：只读内容规则的岗位描述符与调用方给出的队伍所属派系；不读写任务或世界状态。
 * 约束与禁忌：纯查询；岗位主体与数值一律来自 content.rules，本文件不得写具体内容 ID。
 */
import type { GameContent } from "@world-prism/module-sdk";

/**
 * 参与者里是否有执行队伍所属派系的支持者。
 * 任务随队加成只认本派：参与者角色档案的 `factionId` 必须与队伍所属派系一致，
 * 避免跨派邀请（例如泊星者队伍邀请公社陶安）套用本派加成。
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

/** 参与者里是否有通用主体（对任何队伍同效、不限定本派）。 */
function hasUniversalParticipant(content: GameContent, participants: readonly string[], agentId: string): boolean {
  return participants.includes(agentId);
}

/** 运输运力加成：本派物资支持者随队时按规则参数加成，否则为 0。 */
export function transportCapacityBonus(
  content: GameContent,
  ownerFactionId: string | null,
  participants: readonly string[],
): number {
  const supporter = content.rules.tasks.capacitySupporter;
  return hasFactionSupporter(content, ownerFactionId, participants, supporter.agentId)
    ? supporter.capacityBonus
    : 0;
}

/** 运输任务的实际运力：队伍基准运力加本派物资支持者加成；派遣校验与出发校验共用同一来源。 */
export function teamTransportCapacity(
  content: GameContent,
  ownerFactionId: string | null,
  baseCapacity: number,
  participants: readonly string[],
): number {
  return baseCapacity + transportCapacityBonus(content, ownerFactionId, participants);
}

/** 修复稳定度加成：本派工务支持者随队时的加成值，否则为 0。 */
export function repairStabilityBonus(
  content: GameContent,
  ownerFactionId: string | null,
  participants: readonly string[],
): number {
  const supporter = content.rules.tasks.repairSupporter;
  return hasFactionSupporter(content, ownerFactionId, participants, supporter.agentId)
    ? supporter.stabilityBonus
    : 0;
}

/** 队伍是否适用仅能源修复：修复不需要供给库存点，且不享受通用修复者的额外加成。 */
export function isEnergyOnlyRepairTeam(content: GameContent, teamId: string): boolean {
  return content.rules.tasks.energyOnlyRepairTeamIds.includes(teamId);
}

/** 修复完成的基础稳定度：普通队伍与仅能源队伍各取内容声明的数值。 */
export function repairBaseStability(content: GameContent, teamId: string): number {
  const base = content.rules.tasks.repairBaseStability;
  return isEnergyOnlyRepairTeam(content, teamId) ? base.energyOnly : base.standard;
}

/** 修复稳定度的通用修复者加成：对任何队伍同效，但通用修复者自己声明的豁免队伍除外。 */
export function universalRepairStabilityBonus(
  content: GameContent,
  participants: readonly string[],
  teamId: string,
): number {
  const repairer = content.rules.tasks.universalRepairer;
  if (repairer.excludedTeamIds.includes(teamId) || !hasUniversalParticipant(content, participants, repairer.agentId)) {
    return 0;
  }
  return repairer.stabilityBonus;
}

/** 救援总用时折扣：本派医政支持者随队时的折扣 tick 数，否则为 0。 */
export function rescueDurationDiscount(
  content: GameContent,
  ownerFactionId: string | null,
  participants: readonly string[],
): number {
  const supporter = content.rules.tasks.rescueSupporter;
  return hasFactionSupporter(content, ownerFactionId, participants, supporter.agentId)
    ? supporter.durationDiscountTicks
    : 0;
}

/**
 * 侦察逐路折扣：本派情报支持者或通用向导随队时生效；本派支持者优先取自己的折扣值。
 * 追风（通用向导）按设计对任何队伍同效，因此与侦察支持者并列判定。
 */
export function scoutTravelDiscountPerRoad(
  content: GameContent,
  ownerFactionId: string | null,
  participants: readonly string[],
): number {
  const scout = content.rules.tasks.scoutSupporter;
  if (hasFactionSupporter(content, ownerFactionId, participants, scout.agentId)) {
    return scout.travelDiscountPerRoad;
  }
  const guide = content.rules.tasks.universalGuide;
  return hasUniversalParticipant(content, participants, guide.agentId) ? guide.travelDiscountPerRoad : 0;
}

/**
 * 迁徙道路护送安全加成：本派治安支持者或通用向导随队时取本派岗位的加成值，否则为 0。
 * 追风（通用向导）按设计对任何队伍同效，因此与护送支持者并列判定。
 */
export function escortSafetyBonus(
  content: GameContent,
  ownerFactionId: string | null,
  participants: readonly string[],
): number {
  const escort = content.rules.tasks.escortSupporter;
  const supported =
    hasFactionSupporter(content, ownerFactionId, participants, escort.agentId) ||
    hasUniversalParticipant(content, participants, content.rules.tasks.universalGuide.agentId);
  return supported ? escort.safetyBonus : 0;
}

/** 修复任务的工作节点；库存点必须在该节点或队伍出发节点。 */
export function repairWorkNodeId(content: GameContent): string {
  return content.rules.tasks.repairWorkNodeId;
}
