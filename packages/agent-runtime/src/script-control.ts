/**
 * 核心职责：在闭环实验分支上为实验执行器取得与交还某个 Agent 的脚本控制，并把每次控制变更写成 `ControllerChanged` 生命周期审计。
 * 交互契约：调用方提供活跃存储事务；取得把控制租约从 agent 改为 script 并递增控制代次，交还改回 agent 再递增一次，
 *   控制者主体记为持有窗口的实验 run。命令网关的 fencing 只认当前代次与种类：窗口内 Agent 自己的 turn 与窗口外的脚本代发都按过期控制拒绝。
 * 约束与禁忌：只在 experiment 分支上取得；不创建或删除租约行、不改激活状态与租约期限；真人接管中的身份不能被脚本抢占；
 *   本模块不接入任何 HTTP 或控制台入口。
 */
import { DomainError, type ControllerKind, type Json, type StorageRow, type StorageTransaction } from "@world-prism/contracts";
import { insertLifecycleAuditEvent } from "@world-prism/module-sdk";
import { numberValue, stringValue } from "./runtime-records";

/** 控制变更的生命周期审计类型。 */
export const controllerChangedEventType = "ControllerChanged";

/** 一次脚本控制变更的请求。 */
export interface ScriptControlRequest {
  readonly branchId: string;
  readonly agentId: string;
  /** 控制者主体：持有该窗口的实验 run。 */
  readonly runId: string;
  readonly nowIso: string;
  /** 随审计写入的上下文，例如脚本步骤序号、所在 tick 与命令 ID。 */
  readonly context: Readonly<Record<string, Json>>;
}

/** 一次控制变更前后的种类与代次。 */
export interface ControllerTransition {
  readonly agentId: string;
  readonly fromKind: ControllerKind;
  readonly toKind: ControllerKind;
  readonly fromEpoch: number;
  readonly toEpoch: number;
}

function requireLease(tx: StorageTransaction, branchId: string, agentId: string): StorageRow {
  const lease = tx.branch(branchId).table("controller_leases").get({ agent_id: agentId });
  if (lease === null) {
    throw new DomainError("invalid-state", `分支 ${branchId} 上的 ${agentId} 没有控制租约`, { details: { branchId, agentId } });
  }
  return lease;
}

/** 写入新的控制种类与代次，并在同一事务记一条 `ControllerChanged`。 */
function transition(
  tx: StorageTransaction,
  request: ScriptControlRequest,
  lease: StorageRow,
  toKind: ControllerKind,
  controllerPrincipalId: string | null,
): ControllerTransition {
  const fromKind = stringValue(lease, "controller_kind") as ControllerKind;
  const fromEpoch = numberValue(lease, "controller_epoch");
  const toEpoch = fromEpoch + 1;
  tx.branch(request.branchId).table("controller_leases").put({
    ...lease, controller_kind: toKind, controller_principal_id: controllerPrincipalId, controller_epoch: toEpoch,
  });
  insertLifecycleAuditEvent(tx, {
    runId: request.runId,
    branchId: request.branchId,
    type: controllerChangedEventType,
    subjectId: request.agentId,
    payload: { fromKind, toKind, fromEpoch, toEpoch, controllerPrincipalId: request.runId, context: { ...request.context } },
    createdAt: request.nowIso,
  });
  return { agentId: request.agentId, fromKind, toKind, fromEpoch, toEpoch };
}

/**
 * 取得脚本控制：只在实验分支上、且该身份当前由 Agent 自己控制时成立。
 * 代次递增后，该 Agent 在途与排队的 turn 携带的旧代次一律按过期控制被网关与租约检查拒绝。
 */
export function acquireScriptControl(tx: StorageTransaction, request: ScriptControlRequest): ControllerTransition {
  const branch = tx.rows("branches").get({ branch_id: request.branchId });
  if (branch?.["kind"] !== "experiment" || (branch["status"] !== "active" && branch["status"] !== "paused")) {
    throw new DomainError("forbidden", "脚本控制只能在活动的实验分支上取得", {
      details: { branchId: request.branchId, kind: typeof branch?.["kind"] === "string" ? branch["kind"] : null },
    });
  }
  const lease = requireLease(tx, request.branchId, request.agentId);
  if (lease["controller_kind"] !== "agent") {
    throw new DomainError("invalid-state", `${request.agentId} 当前不由 Agent 自己控制，不能取得脚本控制`, {
      details: { agentId: request.agentId, controllerKind: stringValue(lease, "controller_kind") },
    });
  }
  return transition(tx, request, lease, "script", request.runId);
}

/** 交还脚本控制：只有持有窗口的同一个 run 能交还，交还后代次再递增一次，Agent 以新代次恢复调度。 */
export function releaseScriptControl(tx: StorageTransaction, request: ScriptControlRequest): ControllerTransition {
  const lease = requireLease(tx, request.branchId, request.agentId);
  if (lease["controller_kind"] !== "script" || lease["controller_principal_id"] !== request.runId) {
    throw new DomainError("invalid-state", `${request.agentId} 的脚本控制不属于 ${request.runId}`, {
      details: { agentId: request.agentId, runId: request.runId },
    });
  }
  return transition(tx, request, lease, "agent", null);
}

/**
 * 交还某个 run 在分支上遗留的全部脚本控制，用于执行被打断后的恢复。
 * 每条交还的审计上下文沿用取得时记下的上下文并标记 `recovered: true`，按 agentId 升序处理。
 */
export function releaseLeftoverScriptControl(
  tx: StorageTransaction,
  input: { readonly branchId: string; readonly runId: string; readonly nowIso: string },
): readonly ControllerTransition[] {
  const leases = tx.branch(input.branchId).table("controller_leases")
    .list({ controller_kind: "script", controller_principal_id: input.runId }, { orderBy: [{ column: "agent_id" }] });
  return leases.map((lease) => {
    const agentId = stringValue(lease, "agent_id");
    const acquired = acquiredContext(tx, input.branchId, agentId, numberValue(lease, "controller_epoch"));
    return releaseScriptControl(tx, { ...input, agentId, context: { ...acquired, recovered: true } });
  });
}

/** 取得当前脚本控制代次时写下的审计上下文；找不到时为空对象。 */
function acquiredContext(tx: StorageTransaction, branchId: string, agentId: string, epoch: number): Readonly<Record<string, Json>> {
  const row = tx.get(
    `SELECT json_extract(payload_json, '$.context') AS context FROM lifecycle_events
      WHERE branch_id = ? AND subject_id = ? AND type = ?
        AND json_extract(payload_json, '$.toKind') = 'script' AND json_extract(payload_json, '$.toEpoch') = ?
      ORDER BY seq DESC LIMIT 1`,
    [branchId, agentId, controllerChangedEventType, epoch],
  );
  const text = row?.["context"];
  if (typeof text !== "string") return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Json> : {};
}
