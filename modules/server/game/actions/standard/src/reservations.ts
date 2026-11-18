/**
 * 释放任务预留与退回委托余额，按任务类型选择正确的库存点。
 * 依赖资源/世界端口与任务状态；失败时保留原状态并向调用方传播。
 * 禁止用统一的 from/to 假设处理不同任务资源。
 */
import type { ResourceAmounts } from "@ai-npc/contracts";
import type { GameModulePorts, HandlerContext } from "@ai-npc/module-sdk";
import type { TaskState } from "./state";

type ActionContext = HandlerContext<GameModulePorts, unknown>;

function releases(task: TaskState): readonly { readonly stockpileId: string; readonly amount: ResourceAmounts }[] {
  const zero = { supply: 0, energy: 0, medical: 0 };
  if (task.taskType === "transport" && task.fromStockpileId !== null) {
    return [{ stockpileId: task.fromStockpileId, amount: task.reserved }];
  }
  if (task.taskType === "rescue" && task.toStockpileId !== null && task.reserved.medical > 0) {
    return [{ stockpileId: task.toStockpileId, amount: { ...zero, medical: task.reserved.medical } }];
  }
  if (task.taskType === "repair") {
    const output = [];
    if (task.fromStockpileId !== null && task.reserved.energy > 0) {
      output.push({ stockpileId: task.fromStockpileId, amount: { ...zero, energy: task.reserved.energy } });
    }
    if (task.toStockpileId !== null && task.reserved.supply > 0) {
      output.push({ stockpileId: task.toStockpileId, amount: { ...zero, supply: task.reserved.supply } });
    }
    return output;
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

/** 已工作的修复取消时消耗已预留材料，不退还也不产生修复效果。 */
export function consumeWorkingRepair(context: ActionContext, task: TaskState): void {
  for (const item of releases(task)) {
    context.modules["game.resources"].consume({
      stockpileId: item.stockpileId,
      delta: item.amount,
      reason: "repair-cancelled",
      taskId: task.taskId,
      byId: task.dispatcherId,
    });
  }
}
