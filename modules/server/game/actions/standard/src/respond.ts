/**
 * 邀请应答命令处理器：按主体与任务定位待回复邀请，记录接受/拒绝及原因并发布事件。
 * 依赖任务邀请聚合、任务状态读取、主体解析与事务上下文；不改变队伍或资源。
 * 禁止替他人应答、接受已关闭的邀请或重复写入同一邀请。
 */
import type { Json } from "@world-prism/contracts";
import { commandPayloadOf } from "@world-prism/contracts";
import { effectivePrincipalId, principalsAudience, type HandlerResult } from "@world-prism/module-sdk";
import { readTaskState, type InvitationState } from "./state";
import type { ActionContext } from "./task-shared";

/** 应答邀请：只有被邀请主体能回复，且任务与邀请都必须仍为待定。 */
export function respond(context: ActionContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("task.respond", payload);
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
