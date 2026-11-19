/**
 * 注册任务派遣、邀请应答、取消与出发/工作/完成/返回 job，串起风险、资源和世界状态。
 * 依赖计划校验、完成结算、世界/资源/地图/通信端口与 authority 事务上下文。
 * 命令处理器在资源写入失败时返回 rejected，由命令网关回滚 SAVEPOINT；
 * job 处理器在资源写入失败时抛 DomainError，由 job 事务回滚并保留原任务状态等待重试。
 * 禁止在处理器中使用真实时间、随机 ID 作为种子或越过资源预留直接结算。
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands -- Codacy 缺少 workspace 类型解析，将任务状态与泛型端口字段误判为 unknown。 */
import { DomainError, type AudienceSpec, type Json, type ReasonCode, type ResourceAmounts } from "@ai-npc/contracts";
import {
  effectivePrincipalId,
  factionAudience,
  gameModuleIds,
  principalsAudience,
  requireGameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
} from "@ai-npc/module-sdk";
import { completeTask, failTask } from "./completion";
import { refundDelegation, releaseReserved, settleRepairMaterials } from "./reservations";
import { planDispatch, type DispatchInput } from "./plan";
import { rollRisk } from "./risk";
import { computeTaskRoute } from "./routes";
import { readTaskState, type DelegationDraw, type InvitationState, type TaskState } from "./state";

type ActionContext = HandlerContext<GameModulePorts, unknown>;

/** job 内可失败写入的失败出口：抛 DomainError 回滚整个 job 事务，任务停在失败前状态等待重试。 */
function failJobWrite(action: string, reasonCode: ReasonCode): never {
  throw new DomainError("invalid-state", `${action}失败，job 事务已回滚`, {
    retryable: true,
    details: { reasonCode },
  });
}

function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

function taskEnvelope(task: TaskState): Json {
  return {
    taskId: task.taskId,
    teamId: task.teamId,
    dispatcherId: task.dispatcherId,
    invitees: task.invitees,
    departTick: task.departTick,
    taskType: task.taskType,
    params: task.params,
  } as Json;
}

/** 任务事件受众：主名单加队伍所属派系，需要时再追加节点。 */
function taskAudience(
  principals: readonly string[],
  ownerFactionId: string | null,
  nodeId?: string,
): AudienceSpec[] {
  return [
    ...principalsAudience(principals),
    ...(ownerFactionId === null ? [] : [factionAudience(ownerFactionId)]),
    ...(nodeId === undefined ? [] : [{ kind: "node" as const, nodeId }]),
  ];
}

/** 从内容索引读取队伍所属派系；未知队伍返回 null。 */
function teamOwnerFaction(context: ActionContext, teamId: string): string | null {
  return requireGameContent(context.content).teams.get(teamId)?.ownerFactionId ?? null;
}

function dispatch(context: ActionContext, payload: Json): HandlerResult {
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

function respond(context: ActionContext, payload: Json): HandlerResult {
  const input = payload as unknown as {
    readonly taskId: string;
    readonly response: "accept" | "decline";
    readonly reasonCode?: ReasonCode;
  };
  const principalId = effectivePrincipalId(context.auth);
  const invitations = context.tx.list<InvitationState>("task-invitation");
  const invitation = invitations.find(
    (entry) => entry.state.taskId === input.taskId && entry.state.inviteeId === principalId,
  );
  if (invitation === undefined) {
    return { kind: "rejected", reasonCode: "not-invited", safeMessage: "没有该任务的邀请" };
  }
  const task = readTaskState(context.tx, input.taskId);
  if (task === null || task.status !== "pending" || invitation.state.response !== "pending") {
    return { kind: "rejected", reasonCode: "invitation-closed", safeMessage: "邀请已关闭" };
  }
  const next: InvitationState = {
    ...invitation.state,
    response: input.response,
    reasonCode: input.response === "decline" ? (input.reasonCode ?? null) : null,
  };
  context.tx.put("task-invitation", invitation.state.invitationId, next);
  context.tx.emit(
    "TaskInvitationAnswered",
    {
      invitationId: next.invitationId,
      taskId: next.taskId,
      inviteeId: next.inviteeId,
      response: next.response,
      reasonCode: next.reasonCode,
    },
    principalsAudience([task.dispatcherId, next.inviteeId]),
  );
  return { kind: "accepted" };
}

function cancel(context: ActionContext, payload: Json): HandlerResult {
  const input = payload as unknown as { readonly taskId: string };
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
    context.tx.cancelJobs(`task-depart:${task.taskId}`);
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
    context.tx.cancelJobs(`task-work:${task.taskId}`);
    context.tx.cancelJobs(`task-complete:${task.taskId}`);
    context.tx.cancelJobs(`task-return:${task.taskId}`);
    if (task.taskType === "transport") {
      context.tx.schedule("task.return", task.nominalCompletionTick, `task-return:${task.taskId}`, { taskId: task.taskId });
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

function allowedNodesForTask(content: ReturnType<typeof requireGameContent>, task: TaskState, teamNodeId: string): readonly string[] {
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
    const params = task.params as { readonly groupId: string };
    const group = content.groups.get(params.groupId);
    return group === undefined ? [] : [teamNodeId, group.nodeId];
  }
  if (task.taskType === "repair") {
    return [teamNodeId, "grayharbor"];
  }
  return [teamNodeId, task.workNodeId ?? teamNodeId];
}

function depart(context: ActionContext, taskId: string): void {
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
function work(context: ActionContext, taskId: string): void {
  const task = readTaskState(context.tx, taskId);
  if (task === null || task.status !== "running" || task.taskType !== "repair") {
    return;
  }
  const settled = settleRepairMaterials(context, task);
  if (!settled.ok) {
    failJobWrite("结算修复材料", settled.reasonCode);
  }
}

function complete(context: ActionContext, taskId: string): void {
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

function returnToOrigin(context: ActionContext, taskId: string): void {
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

/** 行动模块的规则贡献。 */
export function createActionsContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: gameModuleIds.actions,
    ownsAggregates: ["task", "task-invitation"],
    commands: [
      { type: "task.dispatch", handler: (context, payload) => dispatch(context as ActionContext, payload) },
      { type: "task.respond", handler: (context, payload) => respond(context as ActionContext, payload) },
      { type: "task.cancel", handler: (context, payload) => cancel(context as ActionContext, payload) },
    ],
    jobs: [
      {
        kind: "task.depart",
        handler: (context, job) => {
          depart(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
      {
        kind: "task.work",
        handler: (context, job) => {
          work(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
      {
        kind: "task.complete",
        handler: (context, job) => {
          complete(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
      {
        kind: "task.return",
        handler: (context, job) => {
          returnToOrigin(context as ActionContext, (job.payload as { readonly taskId: string }).taskId);
        },
      },
    ],
  };
}
