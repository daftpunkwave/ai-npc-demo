/**
 * 结算任务完成效果：资源转移/消耗、队伍与角色移动、指标变化、侦察报告和证据发现。
 * 依赖世界/资源/地图/通信端口、内容索引与任务状态；写入都在 authority 事务内。
 * 禁止在这里重算风险或把未满足条件的任务标记为成功。
 */
/* eslint-disable @typescript-eslint/restrict-plus-operands -- Codacy 缺少 workspace 类型解析，将任务状态字段误判为 unknown。 */
import type { ReasonCode } from "@ai-npc/contracts";
import { requireGameContent, type GameModulePorts, type HandlerContext } from "@ai-npc/module-sdk";
import type { TaskState } from "./state";

type CompletionContext = HandlerContext<GameModulePorts, unknown>;

type CompletionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly safeMessage: string };

function moveTeamAndParticipants(context: CompletionContext, task: TaskState, nodeId: string): void {
  const ports = context.modules;
  for (const participant of task.participants) {
    ports["game.world"].setCharacterTask(participant, null);
    ports["game.world"].moveCharacter(participant, nodeId);
  }
  ports["game.world"].moveTeam(task.teamId, nodeId);
  const busyUntil = task.teamInjured ? context.tx.worldTick + 24 : null;
  ports["game.world"].setTeamStatus(
    task.teamId,
    task.teamInjured ? "recovering" : "idle",
    busyUntil,
    null,
  );
}

function scoutReport(context: CompletionContext, task: TaskState, nodeId: string): void {
  const content = requireGameContent(context.content);
  const ports = context.modules;
  const roads = [...content.roads.values()]
    .filter((road) => road.a === nodeId || road.b === nodeId)
    .map((road) => ({ roadId: road.roadId, status: ports["game.map"].roadStatus(road.roadId) ?? "open" }));
  const characters = ports["game.world"].characters().filter((character) => character.nodeId === nodeId);
  const groups = ports["game.world"].groups().filter((group) => group.nodeId === nodeId);
  const team = content.teams.get(task.teamId);
  const audience = [
    ...taskAudience(task),
    ...(team === undefined ? [] : [{ kind: "faction" as const, factionId: team.ownerFactionId }]),
  ];
  context.tx.emit(
    "ScoutReported",
    {
      taskId: task.taskId,
      nodeId,
      report: {
        roads,
        characterIds: characters.map((character) => character.agentId),
        groups: groups.map((group) => ({ groupId: group.groupId, status: group.status })),
      },
    },
    audience,
  );
  for (const evidence of content.evidence.values()) {
    if (evidence.nodeId !== nodeId || evidence.discoverable !== true) {
      continue;
    }
    const discovered = ports["game.world"].discoverEvidence({
      evidenceId: evidence.evidenceId,
      discoveredBy: task.dispatcherId,
      taskId: task.taskId,
    });
    if (discovered.ok) {
      for (const principalId of [task.dispatcherId, ...task.participants]) {
        ports["game.comms"].grantKnowledge({
          principalId,
          itemId: evidence.evidenceId,
          via: "discovery",
        });
      }
    }
  }
}

function taskAudience(task: TaskState): { kind: "principals"; ids: string[] }[] {
  return [{ kind: "principals", ids: [...new Set([task.dispatcherId, ...task.participants])] }];
}

/** 执行任务完成效果并写入 completed 状态；失败时不写完成状态。 */
export function completeTask(context: CompletionContext, task: TaskState): CompletionResult {
  const content = requireGameContent(context.content);
  const ports = context.modules;
  const completedAt = task.nominalCompletionTick + task.delayTicks;
  const workNodeId = task.workNodeId ?? ports["game.world"].team(task.teamId)?.nodeId;
  if (workNodeId === undefined || workNodeId === null) {
    return { ok: false, reasonCode: "invalid-params", safeMessage: "任务缺少工作节点" };
  }
  if (task.taskType === "transport") {
    if (task.fromStockpileId === null || task.toStockpileId === null) {
      return { ok: false, reasonCode: "invalid-params", safeMessage: "运输任务缺少库存点" };
    }
    const params = task.params as { readonly cargo: { supply: number; energy: number; medical: number } };
    const transferred = ports["game.resources"].transfer({
      fromStockpileId: task.fromStockpileId,
      toStockpileId: task.toStockpileId,
      delta: params.cargo,
      taskId: task.taskId,
      byId: task.dispatcherId,
    });
    if (!transferred.ok) {
      return { ok: false, reasonCode: transferred.reasonCode, safeMessage: "运输资源转移失败" };
    }
  } else if (task.taskType === "rescue") {
    const params = task.params as { readonly groupId: string };
    if (task.reserved.medical > 0 && task.toStockpileId !== null) {
      const consumed = ports["game.resources"].consume({
        stockpileId: task.toStockpileId,
        delta: { supply: 0, energy: 0, medical: task.reserved.medical },
        reason: "rescue",
        taskId: task.taskId,
        byId: task.dispatcherId,
      });
      if (!consumed.ok) {
        return { ok: false, reasonCode: consumed.reasonCode, safeMessage: "救援医疗材料消耗失败" };
      }
    }
    ports["game.world"].setGroupStatus(params.groupId, "rescued", null, 0);
    ports["game.world"].changeMeter("migration.safety", 10, "task");
  } else if (task.taskType === "repair") {
    if (task.fromStockpileId !== null) {
      const energy = ports["game.resources"].consume({
        stockpileId: task.fromStockpileId,
        delta: { supply: 0, energy: task.reserved.energy, medical: 0 },
        reason: "repair",
        taskId: task.taskId,
        byId: task.dispatcherId,
      });
      if (!energy.ok) {
        return { ok: false, reasonCode: energy.reasonCode, safeMessage: "修复能源消耗失败" };
      }
    }
    if (task.toStockpileId !== null && task.reserved.supply > 0) {
      const supply = ports["game.resources"].consume({
        stockpileId: task.toStockpileId,
        delta: { supply: task.reserved.supply, energy: 0, medical: 0 },
        reason: "repair",
        taskId: task.taskId,
        byId: task.dispatcherId,
      });
      if (!supply.ok) {
        return { ok: false, reasonCode: supply.reasonCode, safeMessage: "修复供给消耗失败" };
      }
    }
    const teamStar = task.teamId === "team-star";
    let delta = teamStar ? 40 : 25;
    if (task.participants.includes("npc-shenli")) {
      delta += 10;
    }
    if (task.participants.includes("npc-luo") && !teamStar) {
      delta += 15;
    }
    ports["game.world"].changeMeter("relay.stability", delta, "task");
  } else if (task.taskType === "scout") {
    scoutReport(context, task, workNodeId);
  } else {
    const params = task.params as { readonly roadId: string };
    if (content.migrationRoads.includes(params.roadId)) {
      const bonus = task.participants.includes("npc-cenyan") || task.participants.includes("npc-zhuifeng") ? 4 : 0;
      ports["game.world"].changeMeter("migration.safety", 12 + bonus, "task");
    }
  }
  moveTeamAndParticipants(context, task, workNodeId);
  const next: TaskState = {
    ...task,
    status: "completed",
    completedAtTick: completedAt,
    phase: "working",
  };
  context.tx.put("task", task.taskId, next);
  context.tx.emit(
    "TaskCompleted",
    { taskId: task.taskId, taskType: task.taskType, completedAtTick: completedAt, effects: [{ kind: task.taskType }] },
    [{ kind: "public" }],
  );
  return { ok: true };
}

/** 任务出发后失败的统一收尾；资源预留由调用方先释放。 */
export function failTask(
  context: CompletionContext,
  task: TaskState,
  reasonCode: ReasonCode,
): void {
  context.tx.put("task", task.taskId, {
    ...task,
    status: "failed",
    failureReason: reasonCode,
    completedAtTick: context.tx.worldTick,
  });
  context.tx.emit("TaskFailed", { taskId: task.taskId, reasonCode }, [{ kind: "public" }]);
  context.modules["game.world"].setTeamStatus(task.teamId, "idle", null, null);
  for (const participant of task.participants) {
    context.modules["game.world"].setCharacterTask(participant, null);
  }
}
