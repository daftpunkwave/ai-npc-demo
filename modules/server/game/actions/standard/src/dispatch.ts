/**
 * 派遣命令处理器：按十步校验生成计划，登记库存预留与委托扣减、占用救援群体并提交任务与邀请。
 * 依赖计划校验、世界/资源端口、内容索引与事务上下文；不执行 job，也不在失败时保留预留。
 * 禁止越过资源预留直接结算、使用真实时间或自造成随机种子。
 */
import type { Json } from "@ai-npc/contracts";
import { effectivePrincipalId, principalsAudience, type HandlerResult } from "@ai-npc/module-sdk";
import { planDispatch, type DispatchInput } from "./plan";
import type { DelegationDraw, InvitationState, TaskState } from "./state";
import { asPorts, taskAudience, taskEnvelope, teamOwnerFaction, type ActionContext } from "./task-shared";

/** 派遣：先按规则校验并预留资源/委托，再写任务、邀请与离队 job。 */
export function dispatch(context: ActionContext, payload: Json): HandlerResult {
  const input = payload as unknown as DispatchInput;
  const plan = planDispatch(context, input);
  if (!plan.ok) {
    return { kind: "rejected", reasonCode: plan.reasonCode, safeMessage: plan.safeMessage };
  }
  const taskId = context.ids("task");
  for (const stockpile of plan.plan.stockpiles) {
    const reservedResult = asPorts(context)["game.resources"].reserve({
      stockpileId: stockpile.stockpileId,
      delta: stockpile.amount,
      taskId,
      byId: effectivePrincipalId(context.auth),
    });
    if (!reservedResult.ok) {
      // 返回 rejected 后命令网关回滚整个 SAVEPOINT，之前登记的预留不会提交。
      return { kind: "rejected", reasonCode: reservedResult.reasonCode, safeMessage: "资源预留失败" };
    }
  }
  const delegationDraws: DelegationDraw[] = [];
  for (const stockpile of plan.plan.stockpiles) {
    const authority = asPorts(context)["game.world"].drawAuthority(
      effectivePrincipalId(context.auth),
      stockpile.stockpileId,
    );
    if (authority.kind !== "delegation") {
      continue;
    }
    const result = asPorts(context)["game.world"].drawDelegation(
      effectivePrincipalId(context.auth),
      stockpile.stockpileId,
      stockpile.amount,
    );
    if (!result.ok) {
      return { kind: "rejected", reasonCode: result.reasonCode, safeMessage: "委托余额不足" };
    }
    // 记录实际扣减的委托，任务取消或出发失败时按记录回补，不再按主体与库存点重查。
    delegationDraws.push({
      delegationId: result.delegationId,
      stockpileId: stockpile.stockpileId,
      amount: stockpile.amount,
    });
  }
  const rescueParams = plan.plan.taskType === "rescue"
    ? plan.plan.params as { readonly groupId: string }
    : null;
  if (rescueParams !== null) {
    const claimed = asPorts(context)["game.world"].claimGroup(rescueParams.groupId, taskId);
    if (!claimed.ok) {
      return { kind: "rejected", reasonCode: claimed.reasonCode, safeMessage: "救援群体已被其他任务占用" };
    }
  }
  const task: TaskState = {
    taskId,
    taskType: plan.plan.taskType,
    teamId: plan.plan.teamId,
    dispatcherId: effectivePrincipalId(context.auth),
    invitees: [...plan.plan.invitees],
    participants: [],
    status: "pending",
    params: plan.plan.params as Json,
    route: [...plan.plan.route],
    departTick: plan.plan.departTick,
    nominalCompletionTick: plan.plan.nominalCompletionTick,
    completedAtTick: null,
    phase: "pending",
    reserved: plan.plan.reserved,
    fromStockpileId: plan.plan.fromStockpileId,
    toStockpileId: plan.plan.toStockpileId,
    delegationDraws,
    patrolStartTick: plan.plan.patrolStartTick,
    patrolEndTick: plan.plan.patrolEndTick,
    workStartTick: plan.plan.workStartTick,
    workNodeId: plan.plan.workNodeId,
    riskOutcome: { delayTicks: 0, injuredAgentIds: [], teamInjured: false },
    delayNoticeSent: false,
    materialsConsumed: false,
    failureReason: null,
    canceledAtTick: null,
  };
  context.tx.put("task", taskId, task);
  context.tx.emit(
    "TaskDispatched",
    taskEnvelope(task),
    taskAudience([task.dispatcherId, ...task.invitees], teamOwnerFaction(context, task.teamId)),
  );
  for (const inviteeId of task.invitees) {
    const invitationId = context.ids("inv");
    const invitation: InvitationState = {
      invitationId,
      taskId,
      inviteeId,
      response: "pending",
      reasonCode: null,
    };
    context.tx.put("task-invitation", invitationId, invitation);
    context.tx.emit(
      "TaskInvitationIssued",
      { invitationId, taskId, inviteeId, taskType: task.taskType, departTick: task.departTick },
      principalsAudience([inviteeId, task.dispatcherId]),
    );
  }
  asPorts(context)["game.world"].setTeamStatus(task.teamId, "assigned", task.departTick, taskId);
  context.tx.schedule("task.depart", task.departTick, `task-depart:${taskId}`, { taskId });
  return { kind: "accepted", result: { taskId, departTick: task.departTick } };
}
