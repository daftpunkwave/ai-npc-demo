/**
 * 注册任务派遣、邀请应答、取消与出发/完成/返回 job，串起风险、资源和世界状态。
 * 依赖计划校验、完成结算、世界/资源/地图/通信端口与 authority 事务上下文。
 * 禁止在处理器中使用真实时间、随机 ID 作为种子或越过资源预留直接结算。
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/restrict-plus-operands -- Codacy 缺少 workspace 类型解析，将任务状态与泛型端口字段误判为 unknown。 */
import type { AudienceSpec, Json, ReasonCode, ResourceAmounts } from "@ai-npc/contracts";
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
import { refundDelegation, releaseReserved, consumeWorkingRepair } from "./reservations";
import { planDispatch, type DispatchInput } from "./plan";
import { rollRisk } from "./risk";
import { computeTaskRoute } from "./routes";
import { readTaskState, type InvitationState, type TaskState } from "./state";

type ActionContext = HandlerContext<GameModulePorts, unknown>;

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
  const reserved: { readonly stockpileId: string; readonly amount: ResourceAmounts }[] = [];
  for (const [index, stockpile] of plan.plan.stockpiles.entries()) {
    const reservedResult = asPorts(context)["game.resources"].reserve({
      stockpileId: stockpile.stockpileId,
      delta: stockpile.amount,
      taskId,
      byId: effectivePrincipalId(context.auth),
    });
    if (!reservedResult.ok) {
      for (const previous of reserved.slice(0, index)) {
        asPorts(context)["game.resources"].release({
          stockpileId: previous.stockpileId,
          delta: previous.amount,
          taskId,
          byId: effectivePrincipalId(context.auth),
        });
      }
      return { kind: "rejected", reasonCode: reservedResult.reasonCode, safeMessage: "资源预留失败" };
    }
    reserved.push(stockpile);
  }
  const drawn: { readonly stockpileId: string; readonly amount: ResourceAmounts }[] = [];
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
      for (const item of drawn) {
        asPorts(context)["game.world"].refundDelegation(
          effectivePrincipalId(context.auth),
          item.stockpileId,
          item.amount,
        );
      }
      for (const item of plan.plan.stockpiles) {
        asPorts(context)["game.resources"].release({
          stockpileId: item.stockpileId,
          delta: item.amount,
          taskId,
          byId: effectivePrincipalId(context.auth),
        });
      }
      return { kind: "rejected", reasonCode: result.reasonCode, safeMessage: "委托余额不足" };
    }
    drawn.push(stockpile);
  }
  const rescueParams = plan.plan.taskType === "rescue"
    ? plan.plan.params as { readonly groupId: string }
    : null;
  if (rescueParams !== null) {
    const claimed = asPorts(context)["game.world"].claimGroup(rescueParams.groupId, taskId);
    if (!claimed.ok) {
      for (const item of drawn) {
        asPorts(context)["game.world"].refundDelegation(
          effectivePrincipalId(context.auth),
          item.stockpileId,
          item.amount,
        );
      }
      for (const item of plan.plan.stockpiles) {
        asPorts(context)["game.resources"].release({
          stockpileId: item.stockpileId,
          delta: item.amount,
          taskId,
          byId: effectivePrincipalId(context.auth),
        });
      }
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
    patrolStartTick: plan.plan.patrolStartTick,
    patrolEndTick: plan.plan.patrolEndTick,
    workStartTick: plan.plan.workStartTick,
    workNodeId: plan.plan.workNodeId,
    delayTicks: 0,
    delayNoticeSent: false,
    teamInjured: false,
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
  if (task.status === "pending") {
    releaseReserved(context, task);
    refundDelegation(context, task);
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
    const workingRepair = task.taskType === "repair" && task.workStartTick !== null && context.tx.worldTick >= task.workStartTick;
    if (!workingRepair) {
      releaseReserved(context, task);
      refundDelegation(context, task);
    } else {
      consumeWorkingRepair(context, task);
    }
    if (task.taskType === "rescue") {
      const params = task.params as { readonly groupId: string };
      asPorts(context)["game.world"].releaseGroup(params.groupId, task.taskId);
    }
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
    ...task,
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

function failDeparture(context: ActionContext, task: TaskState, reasonCode: ReasonCode): void {
  releaseReserved(context, task);
  refundDelegation(context, task);
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
  for (const injuredAgentId of risk.injuredAgentIds) {
    ports["game.world"].injureCharacter(injuredAgentId, departedAt + 48, "road-risk");
  }
  const running: TaskState = {
    ...task,
    participants,
    status: "running",
    route: [...route.roadIds],
    departTick: departedAt,
    nominalCompletionTick,
    patrolStartTick: route.patrolStartTick,
    patrolEndTick: route.patrolEndTick,
    workStartTick: route.workStartTick,
    workNodeId: route.workNodeId,
    delayTicks: risk.delayTicks,
    teamInjured: risk.teamInjured,
    phase: route.workStartTick !== null && departedAt >= route.workStartTick ? "working" : "traveling",
  };
  context.tx.put("task", task.taskId, running);
  for (const participant of participants) {
    ports["game.world"].setCharacterTask(participant, task.taskId);
  }
  ports["game.world"].setTeamStatus(task.teamId, "traveling", nominalCompletionTick, task.taskId);
  context.tx.emit(
    "TaskDeparted",
    { taskId, participants: [...participants], route: [...running.route], nominalCompletionTick },
    taskAudience([task.dispatcherId, ...participants], team.ownerFactionId, team.nodeId),
  );
  context.tx.schedule("task.complete", nominalCompletionTick, `task-complete:${taskId}:${nominalCompletionTick}`, { taskId });
}

function complete(context: ActionContext, taskId: string): void {
  const task = readTaskState(context.tx, taskId);
  if (task === null || task.status !== "running") {
    return;
  }
  if ((task.delayTicks as number) > 0 && !task.delayNoticeSent) {
    const newCompletion = (task.nominalCompletionTick as number) + (task.delayTicks as number);
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
  const result = completeTask(context, task);
  if (!result.ok) {
    releaseReserved(context, task);
    refundDelegation(context, task);
    if (task.taskType === "rescue") {
      const params = task.params as { readonly groupId: string };
      asPorts(context)["game.world"].releaseGroup(params.groupId, task.taskId);
    }
    failTask(context, task, result.reasonCode);
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
