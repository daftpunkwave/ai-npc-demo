/**
 * 核心职责：把名册激活适配为 campaign.start 的宿主后续钩子，配额不足时以 budget-exhausted 拒绝整条命令。
 * 交互契约：宿主把钩子注册到命令网关；钩子获得与命令同一事务的存储事务与认证上下文，
 *   名册身份与确定性时间来源由宿主注入。
 * 约束与禁忌：禁止自行开启事务、把激活延后到事件消费阶段，或吞掉配额拒绝继续提交命令。
 */
import type { AuthContext, StorageTransaction } from "@ai-npc/contracts";
import type { HandlerResult } from "@ai-npc/module-sdk";
import { activateAgentRosterInTransaction } from "./activation";

/** 宿主后续钩子在事务内可用的上下文；与命令网关的宿主钩子入参保持结构兼容。 */
export interface CampaignStartActivationContext {
  readonly tx: StorageTransaction;
  readonly auth: AuthContext;
}

export interface CampaignStartActivationOptions {
  /** 按名册顺序排列的身份 ID；缺失的活动身份会在本命令事务内激活。 */
  readonly agentIds: readonly string[];
  /** 宿主时钟；写入 agent_activations.updated_at，测试注入确定性实现。 */
  readonly nowIso: () => string;
}

/**
 * 构造 campaign.start 的宿主后续钩子：campaign 写入、事件提交与名册激活同事务提交或回滚。
 * 配额不足时返回 rejected，命令网关据此回滚全部写入并写入 rejected receipt。
 */
export function createCampaignStartActivationHook(
  options: CampaignStartActivationOptions,
): (context: CampaignStartActivationContext) => HandlerResult {
  return (context) => {
    const outcome = activateAgentRosterInTransaction({
      tx: context.tx,
      branchId: context.auth.branchId,
      agentIds: options.agentIds,
      nowIso: options.nowIso(),
    });
    if (outcome.kind === "rejected") {
      return {
        kind: "rejected",
        reasonCode: outcome.reasonCode,
        safeMessage: `部署级 Agent 配额已耗尽：${outcome.requested} > ${outcome.limit}`,
      };
    }
    return { kind: "accepted" };
  };
}
