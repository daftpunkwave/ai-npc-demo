/**
 * 释放任务预留、按实际扣减回补委托余额，并在工作开始时结算修复材料。
 * 依赖资源/世界端口与任务状态；所有可失败写入都返回结果，由调用方决定事务边界：
 * 命令处理器返回 rejected 后由命令网关回滚整个 SAVEPOINT，job 处理器必须抛 DomainError 让 job 事务回滚。
 * 禁止用统一的 from/to 假设处理不同任务资源，也禁止重复扣减已结算的修复材料。
 */
import type { ReasonCode, ResourceAmounts } from "@ai-npc/contracts";
import { coversAmounts, type GameModulePorts, type HandlerContext } from "@ai-npc/module-sdk";
import type { TaskState } from "./state";

type ActionContext = HandlerContext<GameModulePorts, unknown>;

type ReservationEntry = { readonly stockpileId: string; readonly amount: ResourceAmounts };

/** 一次释放、回补或扣减的结果；失败时调用方必须终止当前事务。 */
export type TaskResourceResult = { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };

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

/** 当前任务仍可退还的预留；修复材料已结算时不再有可释放项，也不再回补委托。 */
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

/** 释放预留；失败时调用方按命令或 job 的事务边界回滚，不写任务状态。 */
export function releaseReserved(context: ActionContext, task: TaskState): TaskResourceResult {
  for (const item of releases(task)) {
    const released = context.modules["game.resources"].release({
      stockpileId: item.stockpileId,
      delta: item.amount,
      taskId: task.taskId,
      byId: task.dispatcherId,
    });
    if (!released.ok) {
      return released;
    }
  }
  return { ok: true };
}

/**
 * 按任务记录的实际委托扣减回补余额。
 * 只回补与可释放预留对应的库存点：修复材料已结算时不释放，也不再回补委托。
 */
export function refundDelegation(context: ActionContext, task: TaskState): TaskResourceResult {
  const releasedStockpiles = new Set(releases(task).map((item) => item.stockpileId));
  for (const draw of task.delegationDraws) {
    if (!releasedStockpiles.has(draw.stockpileId)) {
      continue;
    }
    const refunded = context.modules["game.world"].refundDelegation(draw.delegationId, draw.amount);
    if (!refunded.ok) {
      return refunded;
    }
  }
  return { ok: true };
}

/** 检查目标库存的持有量与预留量是否都覆盖本次按预留扣减的数量。 */
function reservationCovers(context: ActionContext, item: ReservationEntry): boolean {
  const stockpile = context.modules["game.resources"].stockpile(item.stockpileId);
  if (stockpile === null) {
    return false;
  }
  return coversAmounts(stockpile.amount, item.amount) && coversAmounts(stockpile.reserved, item.amount);
}

/**
 * 结算修复任务已预留的能源与供给，并持久化「材料已消耗」标记。
 * 幂等：已标记时直接返回当前状态；出发即在工作节点、task.work、完成与工作中取消都走这里。
 * 先在同一事务内检查所有目标库存，再逐个 consume；扣减失败时返回原因码，
 * 由调用方回滚整个命令或 job 事务，因此不会留下只扣了能源的部分状态。
 */
export function settleRepairMaterials(
  context: ActionContext,
  task: TaskState,
): { readonly ok: true; readonly task: TaskState } | { readonly ok: false; readonly reasonCode: ReasonCode } {
  if (task.taskType !== "repair" || task.materialsConsumed) {
    return { ok: true, task };
  }
  const items = repairReservations(task);
  for (const item of items) {
    if (!reservationCovers(context, item)) {
      return { ok: false, reasonCode: "insufficient-resource" };
    }
  }
  for (const item of items) {
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
