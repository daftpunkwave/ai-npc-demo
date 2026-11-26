/**
 * 核心职责：从行动端口构建玩家任务与其他队伍路线摘要的玩家可见视图。
 * 交互契约：依赖行动端口与世界端口；队伍路线只从行动端口读取。
 * 约束与禁忌：其他任务不暴露任务类型、参数、参与者与内部风险。
 */
import type { PlayerTaskView } from "@world-prism/contracts";
import type { GameActionsPort, GameWorldPort, TaskView } from "@world-prism/module-sdk";

/** 自己的任务给出完整参数与两个状态列；参数由投影 schema 按 taskType 复核。 */
function ownTaskView(task: TaskView): PlayerTaskView {
  return {
    kind: "own",
    taskId: task.taskId,
    taskType: task.taskType,
    teamId: task.teamId,
    participants: [...task.participants],
    params: task.params as PlayerTaskView["params"],
    commandStatus: "accepted",
    taskStatus: task.status,
    departTick: task.departTick,
    nominalCompletionTick: task.nominalCompletionTick,
    delayNoticeSent: task.delayNoticeSent,
    route: null,
  };
}

/** 其他任务只暴露「某队伍在路上」与路线，不含任务类型、参数、参与者与内部风险。 */
function otherTaskView(teamId: string, task: TaskView): PlayerTaskView {
  return {
    kind: "other",
    taskId: null,
    taskType: null,
    teamId,
    participants: [],
    params: null,
    commandStatus: null,
    taskStatus: null,
    departTick: null,
    nominalCompletionTick: null,
    delayNoticeSent: false,
    route: [...task.route],
  };
}

/**
 * 任务：玩家派遣或参与的任务走完整视图；其他队伍正在途中的任务只按队伍给出路线摘要。
 * 队伍当前任务的路线只从行动端口读取，不读取任务的风险抽样结果。
 */
export function taskViews(input: {
  readonly actions: GameActionsPort | undefined;
  readonly world: GameWorldPort;
  readonly playerPrincipalId: string;
}): PlayerTaskView[] {
  const { actions, world, playerPrincipalId } = input;
  if (actions === undefined) {
    return [];
  }
  const ownTasks = actions.tasksOf(playerPrincipalId);
  const ownTaskIds = new Set(ownTasks.map((task) => task.taskId));
  const views = ownTasks
    .map(ownTaskView)
    .sort((left, right) => (left.taskId ?? "").localeCompare(right.taskId ?? ""));
  const summaries: PlayerTaskView[] = [];
  for (const team of world.teams()) {
    if (team.status !== "traveling" || team.currentTaskId === null || ownTaskIds.has(team.currentTaskId)) {
      continue;
    }
    const task = actions.task(team.currentTaskId);
    if (task === null || task.route.length === 0) {
      continue;
    }
    summaries.push(otherTaskView(team.teamId, task));
  }
  summaries.sort((left, right) => left.teamId.localeCompare(right.teamId));
  return [...views, ...summaries];
}
