/**
 * 任务 job 处理器：出发、到达工作起点、完成与运输返回；负责参与人校验、路线/风险结算与失败回滚。
 * 依赖任务状态、完成结算、风险与路线辅助、世界端口与事务上下文；不改写邀请应答命令。
 * 禁止在 job 中改写已失败的既有任务状态、忽略可失败写入的返回值，或用真实时间推进。
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands -- 任务/路线字段在运行期均为 number，静态分析缺少 workspace 类型解析时把它们视为 unknown。 */
import type { ReasonCode, ResourceAmounts } from "@ai-npc/contracts";
import { principalsAudience, requireGameContent } from "@ai-npc/module-sdk";
import { completeTask, failTask } from "./completion";
import { refundDelegation, releaseReserved, settleRepairMaterials } from "./reservations";
import { rollRisk } from "./risk";
import { computeTaskRoute } from "./routes";
import { readTaskState, type InvitationState, type TaskState } from "./state";
import {
  asPorts,
  failJobWrite,
  taskAudience,
  teamOwnerFaction,
  type ActionContext,
} from "./task-shared";

/**
 * job 内让任务失败：先释放预留并回补委托，再提交 TaskFailed。
 * 清理写入失败时抛 DomainError，job 事务整体回滚，任务保持 pending 等待重试。
 */
function failDeparture(context: ActionContext, task: TaskState, reasonCode: ReasonCode): void {
  const released = releaseReserved(context, task);
  if (!released.ok) {
    failJobWrite("释放任务预留", released.reasonCode);
  }
  const refunded = refundDelegation(context, task);
  if (!refunded.ok) {
    failJobWrite("回补委托余额", refunded.reasonCode);
  }
  if (task.taskType === "rescue") {
    const params = task.params as { readonly groupId: string };
    asPorts(context)["game.world"].releaseGroup(params.groupId, task.taskId);
  }
  failTask(context, task, reasonCode);
}

/** 参与人允许出现的节点：按任务类型限定在队伍、起点、道路或群体节点附近。 */
function allowedNodesForTask(
  content: ReturnType<typeof requireGameContent>,
  task: TaskState,
  teamNodeId: string,
): readonly string[] {
  if (task.taskType === "transport") {
    const params = task.params as { readonly fromStockpileId: string };
    const stockpile = content.stockpiles.get(params.fromStockpileId);
    return stockpile === undefined ? [] : [stockpile.nodeId];
  }
  if (task.taskType === "escort") {
    const params = task.params as { readonly roadId: string };
    const road = content.roads.get(params.roadId);
    return road === undefined ? [] : [teamNodeId, road.a, road.b];
  }
  if (task.taskType === "rescue") {
    const params = task.params as { readonly groupId: string; readonly toNodeId: string };
    const group = content.groups.get(params.groupId);
    return group === undefined ? [] : [teamNodeId, group.nodeId, params.toNodeId];
  }
  if (task.taskType === "repair") {
    return [teamNodeId, "grayharbor"];
  }
  return [teamNodeId, task.workNodeId ?? teamNodeId];
}

/** 出发 job：确认参与人可用与容量，计算路线与风险，写入运行态并安排工作/完成 job。 */
export function depart(context: ActionContext, taskId: string): void {
  const task = readTaskState(context.tx, taskId);
  if (task === null || task.status !== "pending") {
    return;
  }
  const invitations = context.tx.list<InvitationState>("task-invitation").filter((entry) => entry.state.taskId === taskId);
  const participants: string[] = [];
  for (const entry of invitations) {
    if (entry.state.response === "accept") {
      participants.push(entry.state.inviteeId);
    } else if (entry.state.response === "pending") {
      context.tx.put("task-invitation", entry.state.invitationId, { ...entry.state, response: "expired" });
      context.tx.emit(
        "TaskInvitationExpired",
        {
          invitationId: entry.state.invitationId,
          taskId,
          inviteeId: entry.state.inviteeId,
          response: null,
          reasonCode: null,
        },
        principalsAudience([entry.state.inviteeId, task.dispatcherId]),
      );
    }
  }
  const ports = asPorts(context);
  const team = ports["game.world"].team(task.teamId);
  if (team === null) {
    failDeparture(context, task, "invalid-params");
    return;
  }
  const content = requireGameContent(context.content);
  const allowedNodes = allowedNodesForTask(content, task, team.nodeId);
  for (const participant of participants) {
    const character = ports["game.world"].character(participant);
    if (
      character === null ||
      character.currentTaskId !== null ||
      (character.injuredUntilTick !== null && character.injuredUntilTick > context.tx.worldTick) ||
      !allowedNodes.includes(character.nodeId)
    ) {
      failDeparture(context, task, "participant-unavailable");
      return;
    }
  }
  if (task.taskType === "transport") {
    const params = task.params as { readonly cargo: ResourceAmounts };
    const capacity = team.capacity + (participants.includes("npc-wenyuan") ? 5 : 0);
    if (params.cargo.supply + params.cargo.energy + params.cargo.medical > capacity) {
      failDeparture(context, task, "over-capacity");
      return;
    }
  }
  const departedAt = context.tx.worldTick;
  const route = computeTaskRoute(
    ports,
    content,
    { taskType: task.taskType, teamId: task.teamId, params: task.params as Record<string, unknown> },
    team.nodeId,
    team.ownerFactionId,
    departedAt,
    participants,
  );
  if (route === null) {
    failDeparture(context, task, "route-closed");
    return;
  }
  const nominalCompletionTick = departedAt + route.duration;
  const risk = rollRisk(context, {
    ...task,
    participants,
    route: [...route.roadIds],
    departTick: departedAt,
  });
  // 道路延误整体顺延行程，工作起点与完成 tick 使用同一份延误量。
  const workStartTick = route.workStartTick === null ? null : route.workStartTick + risk.delayTicks;
  // 出发只持久化内部风险；伤势在完成的结算事务里应用并公开。
  const running: TaskState = {
    ...task,
    participants,
    status: "running",
    route: [...route.roadIds],
    departTick: departedAt,
    nominalCompletionTick,
    patrolStartTick: route.patrolStartTick,
    patrolEndTick: route.patrolEndTick,
    workStartTick,
    workNodeId: route.workNodeId,
    riskOutcome: {
      delayTicks: risk.delayTicks,
      injuredAgentIds: [...risk.injuredAgentIds],
      teamInjured: risk.teamInjured,
    },
    phase: workStartTick !== null && departedAt >= workStartTick ? "working" : "traveling",
  };
  context.tx.put("task", task.taskId, running);
  for (const participant of participants) {
    ports["game.world"].setCharacterTask(participant, task.taskId);
  }
  ports["game.world"].setTeamStatus(task.teamId, "traveling", nominalCompletionTick, task.taskId);
  if (running.workStartTick !== null && running.workStartTick <= departedAt) {
    // 出发时已在该任务的工作节点：同一事务内立即结算已预留的修复材料。
    // 结算失败不可改写成 TaskFailed（那会与已扣的能源并存），必须回滚整个出发 job。
    const settled = settleRepairMaterials(context, running);
    if (!settled.ok) {
      failJobWrite("结算修复材料", settled.reasonCode);
    }
  } else if (running.workStartTick !== null) {
    context.tx.schedule("task.work", running.workStartTick, `task-work:${taskId}`, { taskId });
  }
  context.tx.emit(
    "TaskDeparted",
    { taskId, participants: [...participants], route: [...running.route], nominalCompletionTick },
    taskAudience([task.dispatcherId, ...participants], team.ownerFactionId, team.nodeId),
  );
  context.tx.schedule("task.complete", nominalCompletionTick, `task-complete:${taskId}:${nominalCompletionTick}`, { taskId });
}

/** 到达工作起点时结算修复材料；材料已结算则幂等跳过，失败时回滚 job 事务等待重试。 */
export function work(context: ActionContext, taskId: string): void {
  const task = readTaskState(context.tx, taskId);
  if (task === null || task.status !== "running" || task.taskType !== "repair") {
    return;
  }
  const settled = settleRepairMaterials(context, task);
  if (!settled.ok) {
    failJobWrite("结算修复材料", settled.reasonCode);
  }
}

/** 完成 job：先处理道路延误，再结算材料与任务结果；业务失败时清理预留并提交 TaskFailed。 */
export function complete(context: ActionContext, taskId: string): void {
  const task = readTaskState(context.tx, taskId);
  if (task === null || task.status !== "running") {
    return;
  }
  const delayTicks = task.riskOutcome.delayTicks;
  if (delayTicks > 0 && !task.delayNoticeSent) {
    const newCompletion = task.nominalCompletionTick + delayTicks;
    context.tx.put("task", taskId, { ...task, delayNoticeSent: true });
    context.tx.emit(
      "TaskDelayed",
      { taskId, newCompletionTick: newCompletion, cause: "road-risk" },
      taskAudience([task.dispatcherId, ...task.participants], teamOwnerFaction(context, task.teamId)),
    );
    context.tx.schedule("task.complete", newCompletion, `task-complete:${taskId}:${newCompletion}`, { taskId });
    asPorts(context)["game.world"].setTeamStatus(task.teamId, "traveling", newCompletion, taskId);
    return;
  }
  let current = task;
  if (task.taskType === "repair" && !task.materialsConsumed) {
    // 完成时仍需扣减预留材料；失败必须回滚整个完成 job，不能提交 TaskFailed 掩盖先扣的能源。
    const settled = settleRepairMaterials(context, task);
    if (!settled.ok) {
      failJobWrite("结算修复材料", settled.reasonCode);
    }
    current = settled.task;
  }
  const result = completeTask(context, current);
  if (!result.ok) {
    // 业务结算条件不满足：先释放可退还的预留并回补委托，再提交 TaskFailed。
    // 清理写入失败时抛 DomainError，整个 job 回滚，不留下部分释放或失败任务。
    const released = releaseReserved(context, current);
    if (!released.ok) {
      failJobWrite("释放任务预留", released.reasonCode);
    }
    const refunded = refundDelegation(context, current);
    if (!refunded.ok) {
      failJobWrite("回补委托余额", refunded.reasonCode);
    }
    if (current.taskType === "rescue") {
      const params = current.params as { readonly groupId: string };
      asPorts(context)["game.world"].releaseGroup(params.groupId, current.taskId);
    }
    failTask(context, current, result.reasonCode);
  }
}

/** 运输取消后的返回 job：参与人与队伍回到起点库存点并解除占用。 */
export function returnToOrigin(context: ActionContext, taskId: string): void {
  const task = readTaskState(context.tx, taskId);
  if (task === null || task.status !== "cancelled" || task.taskType !== "transport") {
    return;
  }
  const content = requireGameContent(context.content);
  const origin = task.fromStockpileId === null ? undefined : content.stockpiles.get(task.fromStockpileId);
  if (origin === undefined) {
    return;
  }
  for (const participant of task.participants) {
    asPorts(context)["game.world"].setCharacterTask(participant, null);
    asPorts(context)["game.world"].moveCharacter(participant, origin.nodeId);
  }
  asPorts(context)["game.world"].moveTeam(task.teamId, origin.nodeId);
  asPorts(context)["game.world"].setTeamStatus(task.teamId, "idle", null, null);
}
