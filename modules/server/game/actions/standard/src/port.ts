/**
 * 实现任务查询与巡护覆盖查询，供协议和剧情模块读取行动事实。
 * 依赖任务聚合状态与注入的 scoped WorldTx；不执行任务结算。
 * 禁止在查询中改写任务、队伍或资源状态。
 */
import {
  gameModuleIds,
  type GameActionsPort,
  type ScopedWorldTxFactory,
  type TaskView,
} from "@ai-npc/module-sdk";
import { readActionState, taskStateSchema, type TaskState } from "./state";

function toView(state: TaskState): TaskView {
  return {
    taskId: state.taskId,
    taskType: state.taskType,
    teamId: state.teamId,
    dispatcherId: state.dispatcherId,
    participants: state.participants,
    status: state.status,
    params: state.params,
    completedAtTick: state.completedAtTick,
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
    const state = readActionState(this.tx(), "task", taskId, taskStateSchema);
    return state === null ? null : toView(state);
  }

  tasksOf(principalId: string): readonly TaskView[] {
    return this.tx()
      .list<TaskState>("task")
      .map((entry) => entry.state)
      .filter((state) => state.dispatcherId === principalId || state.participants.includes(principalId))
      .map(toView);
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
