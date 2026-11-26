/**
 * 行动模块处理器的共享辅助：端口收窄、任务事件信封、受众构造与 job 失败出口。
 * 依赖 module-sdk 的处理器上下文与公共受众类型；不持有状态、不读写聚合。
 * 禁止在这里提交事务、吞掉端口失败或绕过内容索引补默认派系。
 */
import { DomainError, type AudienceSpec, type Json, type ReasonCode } from "@world-prism/contracts";
import {
  factionAudience,
  principalsAudience,
  requireGameContent,
  type GameModulePorts,
  type HandlerContext,
} from "@world-prism/module-sdk";
import type { TaskState } from "./state";

/** 行动模块处理器上下文；端口集合固定为服务端游戏端口。 */
export type ActionContext = HandlerContext<GameModulePorts, unknown>;

/** job 内可失败写入的失败出口：抛 DomainError 回滚整个 job 事务，任务停在失败前状态等待重试。 */
export function failJobWrite(action: string, reasonCode: ReasonCode): never {
  throw new DomainError("invalid-state", `${action}失败，job 事务已回滚`, {
    retryable: true,
    details: { reasonCode },
  });
}

/** 从处理器上下文取出游戏端口集合；端口绑定由命令网关与 job 执行器注入。 */
export function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

/** 任务事件的统一信封：只公开任务身份、参与关系与节点参数。 */
export function taskEnvelope(task: TaskState): Json {
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
export function taskAudience(
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
export function teamOwnerFaction(context: ActionContext, teamId: string): string | null {
  return requireGameContent(context.content).teams.get(teamId)?.ownerFactionId ?? null;
}
