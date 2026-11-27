/**
 * 校验 Agent 命令、真人席位代发与实验脚本代发的 controller/turn fencing 代次。
 * 依赖分支级 controller_leases、运行级 turn_runs、命令所在分支的种类与认证上下文；只读取，不修改租约。
 * 禁止在测试开关之外放过缺失或过期代次，也禁止把 turn 终态当作仍可提交。
 */
import type { AuthContext, BranchKind, ReasonCode, StorageTransaction } from "@world-prism/contracts";
import { optionalStorageString, requireStorageNumber, requireStorageString } from "./storage-values";

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
): { readonly controllerEpoch: number; readonly controllerKind: string; readonly expiresAt: string | null } | null {
  const row = tx.branch(branchId).table("controller_leases").get({ agent_id: agentId });
  if (row === null) {
    return null;
  }
  return {
    controllerEpoch: requireStorageNumber(row, "controller_leases", "controller_epoch"),
    controllerKind: requireStorageString(row, "controller_leases", "controller_kind"),
    expiresAt: optionalStorageString(row, "controller_leases", "lease_expires_at"),
  };
}

/** 过期时间只接受可解析的 ISO 字符串；损坏时间按过期处理，避免放过旧控制者。 */
function isExpired(expiresAt: string | null, nowIso: string): boolean {
  if (expiresAt === null) {
    return false;
  }
  const expires = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  return !Number.isFinite(expires) || !Number.isFinite(now) || expires <= now;
}

function verifyAgentTurn(tx: StorageTransaction, auth: AuthContext, nowIso: string): FencingResult {
  if (auth.controllerEpoch === null) {
    return { ok: false, reasonCode: "stale-controller" };
  }
  const lease = controllerLease(tx, auth.branchId, auth.principalId);
  if (
    lease === null ||
    lease.controllerEpoch !== auth.controllerEpoch ||
    lease.controllerKind !== "agent" ||
    isExpired(lease.expiresAt, nowIso)
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
  const expiresAt = optionalStorageString(turn, "turn_runs", "lease_expires_at");
  if (
    branchId !== auth.branchId ||
    agentId !== auth.principalId ||
    turnLeaseEpoch !== auth.turnLeaseEpoch ||
    controllerEpoch !== auth.controllerEpoch ||
    terminalTurnStatuses.has(status) ||
    isExpired(expiresAt, nowIso)
  ) {
    return { ok: false, reasonCode: "stale-turn" };
  }
  return { ok: true };
}

/**
 * 代发者对应的控制者种类：实验执行器以 system 身份代发脚本步骤，只能凭脚本控制；
 * 其余代发来自真人席位，只能凭真人控制。两者互不通用，真人会话拿不到脚本控制的代次也无从冒用。
 */
function actingControllerKind(auth: AuthContext): "script" | "human" {
  return auth.kind === "system" ? "script" : "human";
}

function verifyActingAgent(tx: StorageTransaction, auth: AuthContext, branchKind: BranchKind, nowIso: string): FencingResult {
  if (auth.actingAsAgentId === null) {
    return { ok: true };
  }
  if (auth.controllerEpoch === null) {
    return { ok: false, reasonCode: "stale-controller" };
  }
  const expectedKind = actingControllerKind(auth);
  // 脚本控制只属于闭环实验分支；其他分支上即便出现脚本租约也不承认。
  if (expectedKind === "script" && branchKind !== "experiment") {
    return { ok: false, reasonCode: "stale-controller" };
  }
  const lease = controllerLease(tx, auth.branchId, auth.actingAsAgentId);
  if (
    lease === null ||
    lease.controllerEpoch !== auth.controllerEpoch ||
    lease.controllerKind !== expectedKind ||
    isExpired(lease.expiresAt, nowIso)
  ) {
    return { ok: false, reasonCode: "stale-controller" };
  }
  return { ok: true };
}

/**
 * 校验当前认证上下文；allowDirectAgentCommands 只在测试中为 true，
 * 且只放过 kind=agent、turnId=null 的直接调用。branchKind 是命令所在分支的种类，脚本控制据此限定在实验分支。
 */
export function verifyFencing(
  tx: StorageTransaction,
  auth: AuthContext,
  allowDirectAgentCommands: boolean,
  nowIso: string,
  branchKind: BranchKind,
): FencingResult {
  if (auth.kind === "agent" && !(allowDirectAgentCommands && auth.turnId === null)) {
    const agentResult = verifyAgentTurn(tx, auth, nowIso);
    if (!agentResult.ok) {
      return agentResult;
    }
  }
  return verifyActingAgent(tx, auth, branchKind, nowIso);
}
