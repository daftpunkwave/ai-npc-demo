/**
 * 核心职责：登记与查找研究员发起的调试唤醒触发，并判断目标 Agent 当前是否处于激活状态。
 * 交互契约：在调用方事务内读写 agent-runtime 拥有的 triggers 与 agent_activations；去重键由 operationId 派生，
 *   同一分支内同一 operationId 至多对应一条调试触发。
 * 约束与禁忌：不标记 run、不写审计、不读取时钟；幂等裁决与审计由调用方在同一事务内完成。
 */
import type { StorageTransaction } from "@world-prism/contracts";
import { textCell } from "./runtime-query-cells";

/** 调试触发的优先级：高于常规触发，使研究员的唤醒在下一次调度中被优先处理。 */
const debugTriggerPriority = 100;

function debugTriggerKey(operationId: string): string {
  return `debug:${operationId}`;
}

/** 查找分支内由该 operationId 登记的调试触发所指向的 Agent；未登记时为 null。 */
export function findDebugTriggerAgent(tx: StorageTransaction, branchId: string, operationId: string): string | null {
  const row = tx.get(
    `SELECT agent_id FROM triggers WHERE branch_id = ? AND dedupe_key = ?`,
    [branchId, debugTriggerKey(operationId)],
  );
  return row === null ? null : textCell(row, "triggers", "agent_id");
}

/** Agent 在分支上是否处于激活状态。 */
export function isAgentActive(tx: StorageTransaction, branchId: string, agentId: string): boolean {
  return tx.branch(branchId).table("agent_activations").get({ agent_id: agentId })?.["status"] === "active";
}

/** 为 Agent 登记一条未消费的调试触发；来源引用即 operationId。 */
export function enqueueDebugTrigger(
  tx: StorageTransaction,
  input: {
    readonly branchId: string;
    readonly triggerId: string;
    readonly agentId: string;
    readonly operationId: string;
    readonly createdTick: number;
  },
): void {
  tx.branch(input.branchId).table("triggers").put({
    trigger_id: input.triggerId,
    agent_id: input.agentId,
    kind: "debug",
    priority: debugTriggerPriority,
    source_ref: input.operationId,
    created_tick: input.createdTick,
    dedupe_key: debugTriggerKey(input.operationId),
    consumed_by_turn_id: null,
  });
}
