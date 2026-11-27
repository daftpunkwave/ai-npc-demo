/**
 * 核心职责：在一个存储事务内登记研究员发起的调试唤醒：写入调试触发、把分支所属 run 标记为受污染并记审计。
 * 交互契约：调试触发与激活状态经 agent-runtime，审计读写经 module-sdk 的生命周期审计，当前 tick 由时钟 provider 给出；
 *   run 登记表归宿主，污染标记在此写入。同一分支内以 operationId 幂等，重放必须与首次请求的 Agent、原因与发起人一致。
 * 约束与禁忌：调用方必须提供活跃事务；不推进时钟、不直接调度 turn、不修改世界事实。
 */
import { enqueueDebugTrigger, findDebugTriggerAgent, isAgentActive } from "@world-prism/agent-runtime";
import {
  DomainError,
  type DebugWakeInput,
  type HostServices,
  type StorageTransaction,
} from "@world-prism/contracts";
import { insertLifecycleAuditEvent, latestLifecycleEventByOperation } from "@world-prism/module-sdk";

const debugWakeAuditType = "DebugWakeRequested";

export interface DebugWakeDependencies {
  readonly host: Pick<HostServices, "ids" | "nowIso">;
  /** 分支当前世界 tick；调试触发以它作为创建 tick。 */
  readonly worldTick: (tx: StorageTransaction, branchId: string) => number;
}

/** 校验同一 operationId 的重放与首次请求一致；首次请求的审计缺失时无法证明一致，按数据损坏拒绝。 */
function assertSameWake(tx: StorageTransaction, runId: string, input: DebugWakeInput): void {
  const prior = latestLifecycleEventByOperation(tx, {
    runId,
    branchId: input.branchId,
    type: debugWakeAuditType,
    operationId: input.operationId,
  });
  if (prior === null) {
    throw new DomainError("invalid-state", "调试唤醒缺少对应的审计记录");
  }
  const payload = prior.payload;
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new DomainError("invalid-state", "调试唤醒审计载荷不是对象");
  }
  // 早期审计没有记录发起人，缺省时只比对原因。
  if (payload["reason"] !== input.reason ||
    (payload["principalId"] !== undefined && payload["principalId"] !== input.principalId)) {
    throw new DomainError("idempotency-conflict", "同一 operationId 的调试唤醒请求内容不一致");
  }
}

/** 在调用方事务内登记调试唤醒；已登记的同一 operationId 校验一致后直接返回。 */
export function requestDebugWake(tx: StorageTransaction, input: DebugWakeInput, deps: DebugWakeDependencies): void {
  const { branchId, agentId, reason, operationId, principalId } = input;
  const run = tx.rows("runs").list({ branch_id: branchId })[0];
  const runId = run?.["run_id"];
  if (run === undefined || typeof runId !== "string") {
    throw new DomainError("not-found", `分支 ${branchId} 没有可调试的 run`);
  }
  const existingAgent = findDebugTriggerAgent(tx, branchId, operationId);
  if (existingAgent !== null) {
    if (existingAgent !== agentId) {
      throw new DomainError("idempotency-conflict", "同一 operationId 的调试唤醒请求内容不一致");
    }
    assertSameWake(tx, runId, input);
    return;
  }
  if (!isAgentActive(tx, branchId, agentId)) throw new DomainError("not-found", `Agent ${agentId} 未激活`);
  const createdTick = deps.worldTick(tx, branchId);
  enqueueDebugTrigger(tx, { branchId, triggerId: deps.host.ids("trg"), agentId, operationId, createdTick });
  tx.rows("runs").put({ ...run, contaminated: 1 });
  insertLifecycleAuditEvent(tx, {
    runId,
    branchId,
    type: debugWakeAuditType,
    subjectId: agentId,
    payload: { agentId, reason, operationId, principalId },
    createdAt: deps.host.nowIso(),
  });
}
