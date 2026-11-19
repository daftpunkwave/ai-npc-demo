/**
 * 释放任务预留、退回委托余额，并在工作开始时结算修复材料。
 * 依赖资源/世界端口与任务状态；失败时保留原状态并向调用方传播。
 * 禁止用统一的 from/to 假设处理不同任务资源，也禁止重复扣减已结算的修复材料。
 */
import type { ReasonCode, ResourceAmounts } from "@ai-npc/contracts";
import type { GameModulePorts, HandlerContext } from "@ai-npc/module-sdk";
import type { TaskState } from "./state";

type ActionContext = HandlerContext<GameModulePorts, unknown>;

type ReservationEntry = { readonly stockpileId: string; readonly amount: ResourceAmounts };

/** 只改动一种资源时使用的零值基线。 */
const zeroAmounts: ResourceAmounts = { supply: 0, energy: 0, medical: 0 };

/** 修复任务预留的材料：能源在 fromStockpileId，供给在 toStockpileId。 */
function repairReservations(task: TaskState): readonly ReservationEntry[] {
  const output: ReservationEntry[] = [];
  if (task.fromStockpileId !== null && task.reserved.energy > 0) {
    output.push({ stockpileId: task.fromStockpileId, amount: { ...zeroAmounts, energy: task.reserved.energy } });
  }
  if (task.toStockpileId !== null && task.reserved.supply > 0) {
    output.push({ stockpileId: task.toStockpileId, amount: { ...zeroAmounts, supply: task.reserved.supply } });
  }
  return output;
}

function releases(task: TaskState): readonly ReservationEntry[] {
  if (task.taskType === "transport" && task.fromStockpileId !== null) {
    return [{ stockpileId: task.fromStockpileId, amount: task.reserved }];
  }
  if (task.taskType === "rescue" && task.toStockpileId !== null && task.reserved.medical > 0) {
    return [{ stockpileId: task.toStockpileId, amount: { ...zeroAmounts, medical: task.reserved.medical } }];
  }
  if (task.taskType === "repair") {
    // 已结算的材料不再退还，也不再有可释放的预留。
    return task.materialsConsumed ? [] : repairReservations(task);
  }
  return [];
}

/** 释放预留；调用方只在需要回滚时使用。 */
export function releaseReserved(context: ActionContext, task: TaskState): void {
  for (const item of releases(task)) {
    context.modules["game.resources"].release({
      stockpileId: item.stockpileId,
      delta: item.amount,
      taskId: task.taskId,
      byId: task.dispatcherId,
    });
  }
}

/** 退回委托余额；战略 Agent 的 owner 权限没有委托，失败可忽略。 */
export function refundDelegation(context: ActionContext, task: TaskState): void {
  for (const item of releases(task)) {
    context.modules["game.world"].refundDelegation(task.dispatcherId, item.stockpileId, item.amount);
  }
}

/**
 * 结算修复任务已预留的能源与供给，并持久化「材料已消耗」标记。
 * 幂等：已标记时直接返回当前状态；出发即在工作节点、task.work、完成与工作中取消都走这里。
 */
export function settleRepairMaterials(
  context: ActionContext,
  task: TaskState,
): { readonly ok: true; readonly task: TaskState } | { readonly ok: false; readonly reasonCode: ReasonCode } {
  if (task.taskType !== "repair" || task.materialsConsumed) {
    return { ok: true, task };
  }
  for (const item of repairReservations(task)) {
    const consumed = context.modules["game.resources"].consume({
      stockpileId: item.stockpileId,
      delta: item.amount,
      reason: "repair",
      taskId: task.taskId,
      byId: task.dispatcherId,
    });
    if (!consumed.ok) {
      return { ok: false, reasonCode: consumed.reasonCode };
    }
  }
  const next: TaskState = { ...task, materialsConsumed: true };
  context.tx.put("task", task.taskId, next);
  return { ok: true, task: next };
}
