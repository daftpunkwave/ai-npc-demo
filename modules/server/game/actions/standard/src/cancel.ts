/**
 * 取消任务命令处理器：按任务阶段释放或结算预留与委托，撤销待办 job、队伍占用与未回复邀请。
 * 依赖任务/邀请聚合、预留与委托回补辅助、世界端口与内容索引；不执行完成结算。
 * 禁止让已结束的任务再次取消、跳过失败回滚或把材料结算重复扣减。
 */
import { commandPayloadOf, type Json } from "@world-prism/contracts";
import { effectivePrincipalId, principalsAudience, requireGameContent, type HandlerResult } from "@world-prism/module-sdk";
import { refundDelegation, releaseReserved, settleRepairMaterials } from "./reservations";
import { readTaskState, type InvitationState } from "./state";
import { asPorts, taskAudience, type ActionContext } from "./task-shared";

/** 取消任务：待定阶段释放全部预留，运行阶段按是否已开始工作决定结算或释放。 */
export function cancel(context: ActionContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("task.cancel", payload);
  const task = readTaskState(context.tx, input.taskId);
  if (task === null) {
    return { kind: "rejected", reasonCode: "invalid-params", safeMessage: "任务不存在" };
  }
  const principalId = effectivePrincipalId(context.auth);
  const content = requireGameContent(context.content);
  const team = content.teams.get(task.teamId);
  if (principalId !== task.dispatcherId && team?.ownerFactionId !== principalId) {
    return { kind: "rejected", reasonCode: "no-authority", safeMessage: "只有派遣者或队伍所属派系可以取消" };
  }
  if (task.status !== "pending" && task.status !== "running") {
    return { kind: "rejected", reasonCode: "task-not-cancellable", safeMessage: "任务已结束" };
  }
  let current = task;
  if (task.status === "pending") {
    // 释放或回补失败时返回 rejected：命令网关回滚 SAVEPOINT，任务保持 pending，库存与委托不变。
    const released = releaseReserved(context, task);
    if (!released.ok) {
      return { kind: "rejected", reasonCode: released.reasonCode, safeMessage: "释放任务预留失败" };
    }
    const refunded = refundDelegation(context, task);
    if (!refunded.ok) {
      return { kind: "rejected", reasonCode: refunded.reasonCode, safeMessage: "委托余额回补失败" };
    }
    if (task.taskType === "rescue") {
      const params = task.params as { readonly groupId: string };
      asPorts(context)["game.world"].releaseGroup(params.groupId, task.taskId);
    }
    context.tx.cancelJobs(`task-depart:${String(task.taskId)}`);
    asPorts(context)["game.world"].setTeamStatus(task.teamId, "idle", null, null);
    for (const invitation of context.tx.list<InvitationState>("task-invitation")) {
      if (invitation.state.taskId === task.taskId && invitation.state.response === "pending") {
        context.tx.put("task-invitation", invitation.state.invitationId, {
          ...invitation.state,
          response: "expired",
        });
        context.tx.emit(
          "TaskInvitationExpired",
          {
            invitationId: invitation.state.invitationId,
            taskId: task.taskId,
            inviteeId: invitation.state.inviteeId,
            response: null,
            reasonCode: null,
          },
          principalsAudience([invitation.state.inviteeId, task.dispatcherId]),
        );
      }
    }
  } else {
    // 修复已开始工作（或材料已结算）时按同一幂等函数扣减，不退还；尚未到达则释放预留。
    const workingRepair =
      task.taskType === "repair" &&
      (task.materialsConsumed ||
        (task.workStartTick !== null && context.tx.worldTick >= task.workStartTick));
    if (workingRepair) {
      const settled = settleRepairMaterials(context, task);
      if (!settled.ok) {
        return { kind: "rejected", reasonCode: settled.reasonCode, safeMessage: "修复材料结算失败" };
      }
      // 保留「材料已消耗」标记，避免取消状态把刚结算的标记覆盖回未结算。
      current = settled.task;
    } else {
      const released = releaseReserved(context, task);
      if (!released.ok) {
        return { kind: "rejected", reasonCode: released.reasonCode, safeMessage: "释放任务预留失败" };
      }
      const refunded = refundDelegation(context, task);
      if (!refunded.ok) {
        return { kind: "rejected", reasonCode: refunded.reasonCode, safeMessage: "委托余额回补失败" };
      }
    }
    if (task.taskType === "rescue") {
      const params = task.params as { readonly groupId: string };
      asPorts(context)["game.world"].releaseGroup(params.groupId, task.taskId);
    }
    context.tx.cancelJobs(`task-work:${String(task.taskId)}`);
    context.tx.cancelJobs(`task-complete:${String(task.taskId)}`);
    context.tx.cancelJobs(`task-return:${String(task.taskId)}`);
    if (task.taskType === "transport") {
      context.tx.schedule("task.return", task.nominalCompletionTick, `task-return:${String(task.taskId)}`, { taskId: task.taskId });
      asPorts(context)["game.world"].setTeamStatus(task.teamId, "traveling", task.nominalCompletionTick, task.taskId);
    } else {
      asPorts(context)["game.world"].setTeamStatus(task.teamId, "idle", null, null);
      for (const participant of task.participants) {
        asPorts(context)["game.world"].setCharacterTask(participant, null);
      }
    }
  }
  context.tx.put("task", task.taskId, {
    ...current,
    status: "cancelled",
    canceledAtTick: context.tx.worldTick,
    completedAtTick: context.tx.worldTick,
  });
  context.tx.emit(
    "TaskCancelled",
    { taskId: task.taskId, byId: principalId },
    taskAudience([task.dispatcherId, ...task.participants], team?.ownerFactionId ?? null),
  );
  return { kind: "accepted" };
}
