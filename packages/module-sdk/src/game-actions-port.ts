/**
 * 核心职责：定义行动模块的游戏端口与任务视图类型。
 * 交互契约：依赖公共契约的任务类型与状态词表；端口查询返回任务事实。
 * 约束与禁忌：禁止在这里实现规则或读取行动模块之外的聚合。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type { InvitationView, TaskStatus, TaskType } from "@ai-npc/contracts";

/** 任务查询端口；任务聚合由行动模块拥有。 */
export interface TaskView {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly teamId: string;
  readonly dispatcherId: string;
  /** 受邀角色；受邀者在出发前用 task.respond 回复后才进入 participants。 */
  readonly invitees: readonly string[];
  readonly participants: readonly string[];
  readonly status: TaskStatus;
  readonly params: unknown;
  /** 出发时按路径算出的道路顺序；玩家投影只把「其他任务」的路线给到最小摘要。 */
  readonly route: readonly string[];
  readonly departTick: number;
  /** 不含延误的名义完成 tick；延误只进任务内部状态。 */
  readonly nominalCompletionTick: number;
  readonly completedAtTick: number | null;
  /** 是否已经为延误提交过 TaskDelayed；玩家投影据此显示延误提醒。 */
  readonly delayNoticeSent: boolean;
}

/** 行动模块查询端口；协议履约判定与剧情订阅复用已完成任务事实。 */
export interface GameActionsPort {
  task(taskId: string): TaskView | null;
  tasksOf(principalId: string): readonly TaskView[];
  invitationsOf(inviteeId: string): readonly InvitationView[];
  isRoadEscorted(roadId: string, atTick: number): boolean;
  /**
   * 全部已完成任务，带权威完成 tick。
   * 协议期限 job 与章节统计用它复核「截至期限是否已履约」，不依赖消费者是否追平。
   */
  completedTasks(): readonly TaskView[];
}
