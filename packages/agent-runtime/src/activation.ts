/**
 * 核心职责：在单个存储事务内激活分支名册并执行部署级 15 身份配额。
 * 交互契约：依赖 agent_activations、controller_leases、branch 状态与调用方给出的确定性时间；
 *   事务内入口返回明确结果，供命令钩子据此拒绝整条命令，直接入口按 budget-exhausted 抛出领域错误。
 * 约束与禁忌：禁止跨事务预占、把冻结分支计入配额或静默允许第 16 个身份。
 */
import { DomainError, type StoragePort, type StorageTransaction } from "@world-prism/contracts";

/** 部署级活动 gameplay 身份上限；在线、实验与探针分支共用。 */
export const agentDeploymentQuota = 15;

export interface ActivationResult {
  readonly activated: readonly string[];
  readonly totalActive: number;
}

export interface ActivateAgentRosterInput {
  readonly storage: StoragePort;
  readonly branchId: string;
  readonly agentIds: readonly string[];
  readonly nowIso: string;
}

export interface RosterActivationInput {
  readonly tx: StorageTransaction;
  readonly branchId: string;
  readonly agentIds: readonly string[];
  readonly nowIso: string;
}

/** 事务内激活结果：配额不足时调用方必须拒绝整条命令，不写入任何激活行。 */
export type RosterActivationOutcome =
  | { readonly kind: "activated"; readonly activated: readonly string[]; readonly totalActive: number }
  | {
      readonly kind: "rejected";
      readonly reasonCode: "budget-exhausted";
      readonly requested: number;
      readonly limit: number;
    };

/** 独立事务激活缺失身份；配额不足时抛出 budget-exhausted 领域错误。 */
export function activateAgentRoster(input: ActivateAgentRosterInput): ActivationResult {
  const outcome = input.storage.transact((tx) => activateAgentRosterInTransaction({ ...input, tx }));
  if (outcome.kind === "rejected") {
    throw new DomainError(
      "budget-exhausted",
      `Agent 激活超过部署配额：${outcome.requested} > ${outcome.limit}`,
    );
  }
  return { activated: outcome.activated, totalActive: outcome.totalActive };
}

/** 在调用方事务内激活身份；供命令后续钩子与名字册恢复共用同一事务边界。 */
export function activateAgentRosterInTransaction(input: RosterActivationInput): RosterActivationOutcome {
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
  const requested = current + missing.length;
  if (requested > agentDeploymentQuota) {
    return {
      kind: "rejected",
      reasonCode: "budget-exhausted",
      requested,
      limit: agentDeploymentQuota,
    };
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
  return { kind: "activated", activated: missing, totalActive: requested };
}
