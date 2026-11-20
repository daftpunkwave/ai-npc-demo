/**
 * 在单个存储事务内激活分支名册并执行部署级 15 身份配额。
 * 依赖 agent_activations、controller_leases、branch 状态与宿主时间。
 * 禁止跨事务预占、把冻结分支计入配额或静默允许第 16 个身份。
 */
import type { StoragePort, StorageTransaction } from "@ai-npc/contracts";

export interface ActivationResult {
  readonly activated: readonly string[];
  readonly totalActive: number;
}

/** 激活缺失身份；已激活身份不重复写入，第 16 个活动身份回滚整个事务。 */
export function activateAgentRoster(input: {
  readonly storage: StoragePort;
  readonly branchId: string;
  readonly agentIds: readonly string[];
  readonly nowIso: string;
}): ActivationResult {
  return input.storage.transact((tx) => activateAgentRosterInTransaction({ ...input, tx }));
}

/** 在调用方事务内激活身份；供 CampaignStarted 消费与 inbox/offset 原子提交。 */
export function activateAgentRosterInTransaction(input: {
  readonly tx: StorageTransaction;
  readonly branchId: string;
  readonly agentIds: readonly string[];
  readonly nowIso: string;
}): ActivationResult {
    const branch = input.tx.branch(input.branchId);
    const activations = branch.table("agent_activations");
    const leases = branch.table("controller_leases");
    const missing = input.agentIds.filter((agentId) =>
      activations.get({ agent_id: agentId })?.["status"] !== "active",
    );
    const row = input.tx.all(
      "SELECT COUNT(*) AS count FROM agent_activations a JOIN branches b ON a.branch_id = b.branch_id WHERE a.status = 'active' AND b.status IN ('active', 'paused')",
    )[0];
    const current = Number(row?.["count"] ?? 0);
    if (current + missing.length > 15) {
      throw new Error(`Agent 激活超过部署配额：${current + missing.length} > 15`);
    }
    for (const agentId of missing) {
      activations.put({ agent_id: agentId, status: "active", updated_at: input.nowIso });
      if (leases.get({ agent_id: agentId }) === null) {
        leases.put({
          agent_id: agentId,
          controller_kind: "agent",
          controller_principal_id: null,
          controller_epoch: 1,
          lease_expires_at: null,
        });
      }
    }
    return { activated: missing, totalActive: current + missing.length };
}
