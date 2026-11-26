/**
 * 实现任务查询与巡护覆盖查询，供协议和剧情模块读取行动事实。
 * 依赖任务聚合状态与注入的 scoped WorldTx；不执行任务结算。
 * 禁止在查询中改写任务、队伍或资源状态。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import { DomainError, type InvitationView } from "@world-prism/contracts";
import {
  gameModuleIds,
  type GameActionsPort,
  type ScopedWorldTxFactory,
  type TaskView,
} from "@world-prism/module-sdk";
import { readTaskState, type InvitationState, type TaskState } from "./state";

function toView(state: TaskState): TaskView {
  return {
    taskId: state.taskId,
    taskType: state.taskType,
    teamId: state.teamId,
    dispatcherId: state.dispatcherId,
    invitees: state.invitees,
    participants: state.participants,
    status: state.status,
    params: state.params,
    route: state.route,
    departTick: state.departTick,
    nominalCompletionTick: state.nominalCompletionTick,
    completedAtTick: state.completedAtTick,
    delayNoticeSent: state.delayNoticeSent,
  };
}

/** 任务查询端口；只读当前事务内的任务聚合。 */
class StandardActionsPort implements GameActionsPort {
  private readonly txFor: ScopedWorldTxFactory;

  constructor(txFor: ScopedWorldTxFactory) {
    this.txFor = txFor;
  }

  private tx() {
    return this.txFor(gameModuleIds.actions);
  }

  task(taskId: string): TaskView | null {
    const state = readTaskState(this.tx(), taskId);
    return state === null ? null : toView(state);
  }

  tasksOf(principalId: string): readonly TaskView[] {
    return this.tx()
      .list<TaskState>("task")
      .map((entry) => entry.state)
      .filter((state) => state.dispatcherId === principalId || state.participants.includes(principalId))
      .map(toView);
  }

  invitationsOf(inviteeId: string): readonly InvitationView[] {
    return this.tx()
      .list<InvitationState>("task-invitation")
      .map((entry) => entry.state)
      .filter((invitation) => invitation.inviteeId === inviteeId && invitation.response === "pending")
      .map((invitation) => {
        const task = readTaskState(this.tx(), invitation.taskId);
        if (task === null) {
          throw new DomainError("invalid-state", `邀请 ${invitation.invitationId} 引用了不存在的任务`);
        }
        return {
          invitationId: invitation.invitationId,
          taskId: invitation.taskId,
          inviteeId: invitation.inviteeId,
          taskType: task.taskType,
          departTick: task.departTick,
          response: null,
        };
      })
      .sort((left, right) => left.departTick - right.departTick || left.invitationId.localeCompare(right.invitationId));
  }

  /** 已完成任务按完成 tick 升序给出；完成 tick 缺失的记录不是已提交的完成事实，直接跳过。 */
  completedTasks(): readonly TaskView[] {
    return this.tx()
      .list<TaskState>("task")
      .map((entry) => entry.state)
      .filter((state) => state.status === "completed" && state.completedAtTick !== null)
      .map(toView)
      .sort((left, right) => (left.completedAtTick ?? 0) - (right.completedAtTick ?? 0) || left.taskId.localeCompare(right.taskId));
  }

  isRoadEscorted(roadId: string, atTick: number): boolean {
    return this.tx()
      .list<TaskState>("task")
      .some((entry) => {
        const state = entry.state;
        if (state.taskType !== "escort" || state.status !== "running") {
          return false;
        }
        const params = state.params as { readonly roadId?: unknown };
        return (
          params.roadId === roadId &&
          state.patrolStartTick !== null &&
          state.patrolEndTick !== null &&
          state.patrolStartTick <= atTick &&
          atTick <= state.patrolEndTick
        );
      });
  }
}

/** 构造绑定到当前事务的行动端口。 */
export function createActionsPort(txFor: ScopedWorldTxFactory): GameActionsPort {
  return new StandardActionsPort(txFor);
}
