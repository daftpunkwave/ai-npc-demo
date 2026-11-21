/**
 * 协议模块处理器的共享辅助：端口收窄、主体/队伍归属解析与本事务内的履约事实读取。
 * 依赖 module-sdk 的处理器上下文、行动/通信只读端口、内容派系索引与世界 campaign；不写协议状态。
 * 禁止在这里提交事务、把未提交的任务事实当成履约证据或替当事人记忆承诺。
 */
import { requireGameContent, type GameModulePorts, type HandlerContext, type ShareQuery } from "@ai-npc/module-sdk";
import {
  resolvePrincipalFaction,
  type FulfillmentFactions,
  type FulfillmentFacts,
} from "./fulfillment";

/** 协议模块处理器上下文；端口集合固定为服务端游戏端口。 */
export type AgreementContext = HandlerContext<GameModulePorts, unknown>;

/** 从处理器上下文取出游戏端口集合；端口绑定由命令网关与 job 执行器注入。 */
export function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

/** 队伍所属派系；内容包里没有的队伍返回 null，按「不属于义务人」处理。 */
export function teamOwnerFaction(context: AgreementContext, teamId: string): string | null {
  return requireGameContent(context.content).teams.get(teamId)?.ownerFactionId ?? null;
}

/**
 * 本事务内的主体与队伍归属映射：事件消费者、期限复核与统计端口共用同一口径。
 * 派系主体归属自身，当前 campaign 的玩家归属 campaign.factionId，普通角色与未知主体不映射。
 */
export function fulfillmentFactions(context: AgreementContext): FulfillmentFactions {
  const content = requireGameContent(context.content);
  const campaign = asPorts(context)["game.world"].campaign();
  return {
    factionOfTeam: (teamId) => teamOwnerFaction(context, teamId),
    factionOfPrincipal: (principalId) => resolvePrincipalFaction(principalId, content.factions, campaign),
  };
}

/**
 * 本事务内的已提交履约事实：已完成任务来自行动端口，分享来自通信端口。
 * 只读端口，不改写其他模块聚合。
 */
export function fulfillmentFacts(context: AgreementContext): FulfillmentFacts {
  const ports = asPorts(context);
  return {
    ...fulfillmentFactions(context),
    completedTasks: ports["game.actions"].completedTasks(),
    hasShare: (query: ShareQuery) => ports["game.comms"].hasShare(query),
  };
}
