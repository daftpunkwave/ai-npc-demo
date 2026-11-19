/**
 * 在任务出发时按道路风险进行确定性抽样。
 * 依赖内容道路、行动巡护查询与宿主注入的 rng；结果只写入任务内部状态。
 * 禁止使用 Math.random，禁止把 taskId 或随机 ID 放进随机种子。
 */
import { requireGameContent, type GameModulePorts, type HandlerContext } from "@ai-npc/module-sdk";
import type { TaskState } from "./state";

export interface RiskResult {
  readonly delayTicks: number;
  readonly injuredAgentIds: readonly string[];
  readonly teamInjured: boolean;
}

/** 对路径上每条未被护送的风险道路抽样一次。 */
export function rollRisk(
  context: HandlerContext<GameModulePorts, unknown>,
  task: TaskState,
): RiskResult {
  const content = requireGameContent(context.content);
  const participants = [...task.participants].sort((left, right) => left.localeCompare(right));
  let delayTicks = 0;
  const injuredAgentIds = new Set<string>();
  let teamInjured = false;
  for (const roadId of task.route) {
    const road = content.roads.get(roadId);
    if (road === undefined || road.risk === 0) {
      continue;
    }
    if (context.modules["game.actions"].isRoadEscorted(roadId, task.departTick)) {
      continue;
    }
    const rng = context.rng("risk", task.teamId, String(task.departTick), roadId);
    const delayed = rng() < 0.15 * road.risk;
    const injured = rng() < 0.05 * road.risk;
    if (delayed) {
      delayTicks += 2;
    }
    if (injured) {
      if (participants.length > 0) {
        const victim = participants[Math.floor(rng() * participants.length)] ?? participants[0];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
        if (victim !== undefined) {
          injuredAgentIds.add(victim);
        }
      } else {
        teamInjured = true;
      }
    }
  }
  return { delayTicks, injuredAgentIds: [...injuredAgentIds], teamInjured };
}
