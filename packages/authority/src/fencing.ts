/**
 * 校验 Agent 命令与真人席位代发的 controller/turn fencing 代次。
 * 依赖分支级 controller_leases、运行级 turn_runs 与认证上下文；只读取，不修改租约。
 * 禁止在测试开关之外放过缺失或过期代次，也禁止把 turn 终态当作仍可提交。
 */
import type { AuthContext, ReasonCode, StorageTransaction } from "@ai-npc/contracts";
import { requireStorageNumber, requireStorageString } from "./storage-values";

/** fencing 校验结果：失败只返回 receipt 原因码，不抛通用异常。 */
export type FencingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: ReasonCode };

const terminalTurnStatuses: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "budget-exhausted",
]);

function controllerLease(
  tx: StorageTransaction,
  branchId: string,
  agentId: string,
): { readonly controllerEpoch: number; readonly controllerKind: string } | null {
  const row = tx.branch(branchId).table("controller_leases").get({ agent_id: agentId });
  if (row === null) {
    return null;
  }
  return {
    controllerEpoch: requireStorageNumber(row, "controller_leases", "controller_epoch"),
    controllerKind: requireStorageString(row, "controller_leases", "controller_kind"),
  };
}

function verifyAgentTurn(tx: StorageTransaction, auth: AuthContext): FencingResult {
  if (auth.controllerEpoch === null) {
    return { ok: false, reasonCode: "stale-controller" };
  }
  const lease = controllerLease(tx, auth.branchId, auth.principalId);
  if (
    lease === null ||
    lease.controllerEpoch !== auth.controllerEpoch ||
    lease.controllerKind !== "agent"
  ) {
    return { ok: false, reasonCode: "stale-controller" };
  }
  if (auth.turnId === null || auth.turnLeaseEpoch === null) {
    return { ok: false, reasonCode: "stale-turn" };
  }
  const turn = tx.rows("turn_runs").get({ turn_id: auth.turnId });
  if (turn === null) {
    return { ok: false, reasonCode: "stale-turn" };
  }
  const branchId = requireStorageString(turn, "turn_runs", "branch_id");
  const agentId = requireStorageString(turn, "turn_runs", "agent_id");
  const turnLeaseEpoch = requireStorageNumber(turn, "turn_runs", "turn_lease_epoch");
  const controllerEpoch = requireStorageNumber(turn, "turn_runs", "controller_epoch");
  const status = requireStorageString(turn, "turn_runs", "status");
  if (
    branchId !== auth.branchId ||
    agentId !== auth.principalId ||
    turnLeaseEpoch !== auth.turnLeaseEpoch ||
    controllerEpoch !== auth.controllerEpoch ||
    terminalTurnStatuses.has(status)
  ) {
    return { ok: false, reasonCode: "stale-turn" };
  }
  return { ok: true };
}

function verifyActingAgent(tx: StorageTransaction, auth: AuthContext): FencingResult {
  if (auth.actingAsAgentId === null) {
    return { ok: true };
  }
  if (auth.controllerEpoch === null) {
    return { ok: false, reasonCode: "stale-controller" };
  }
  const lease = controllerLease(tx, auth.branchId, auth.actingAsAgentId);
  if (
    lease === null ||
    lease.controllerEpoch !== auth.controllerEpoch ||
    lease.controllerKind !== "human"
  ) {
    return { ok: false, reasonCode: "stale-controller" };
  }
  return { ok: true };
}

/**
 * 校验当前认证上下文；allowDirectAgentCommands 只在测试中为 true，
 * 且只放过 kind=agent、turnId=null 的直接调用。
 */
export function verifyFencing(
  tx: StorageTransaction,
  auth: AuthContext,
  allowDirectAgentCommands: boolean,
): FencingResult {
  if (auth.kind === "agent" && !(allowDirectAgentCommands && auth.turnId === null)) {
    const agentResult = verifyAgentTurn(tx, auth);
    if (!agentResult.ok) {
      return agentResult;
    }
  }
  return verifyActingAgent(tx, auth);
}
