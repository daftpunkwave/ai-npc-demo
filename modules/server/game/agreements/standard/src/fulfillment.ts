/**
 * 按条款判断「截至期限是否已由已提交事实满足」，供协议事件消费、期限 job 与章节统计共用。
 * 依赖公共条款、行动模块的任务视图、内容派系索引与协议聚合状态；全部函数同步且无副作用。
 * 只有协议生效之后、条款期限之前完成的任务或提交的分享才算履约；
 * 禁止用消费时钟、未提交事实、生效前的事实或期限之后的完成来判定履约，也禁止在这里写聚合或发事件。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名用于表达调用契约。 */
/* eslint-disable security/detect-object-injection -- cargo 的键来自受限枚举 ResourceId，任务参数已由调用方按条款收窄。 */
import type { ResourceId, Term } from "@ai-npc/contracts";
import type { CampaignView, ShareQuery, TaskView } from "@ai-npc/module-sdk";
import type { AgreementState } from "./state";

/** 协议主体与队伍到派系的映射；履约判定只在下列两个函数里解释「谁代表谁」。 */
export interface FulfillmentFactions {
  readonly factionOfTeam: (teamId: string) => string | null;
  readonly factionOfPrincipal: (principalId: string) => string | null;
}

/** 履约事实来源：已完成任务、证据分享查询与主体/队伍归属解析。 */
export interface FulfillmentFacts extends FulfillmentFactions {
  readonly completedTasks: readonly TaskView[];
  readonly hasShare: (query: ShareQuery) => boolean;
}

/**
 * 协议主体到派系的统一映射：派系主体归属自身，当前 campaign 的玩家归属 campaign.factionId；
 * 普通角色与未知主体返回 null，保持自身主体语义，不把角色当成整个派系。
 */
export function resolvePrincipalFaction(
  principalId: string,
  factions: ReadonlyMap<string, unknown>,
  campaign: CampaignView | null,
): string | null {
  if (factions.has(principalId)) {
    return principalId;
  }
  return campaign !== null && campaign.playerId === principalId ? campaign.factionId : null;
}

/** 实际行为人是否代表义务人：同一主体，或两者归属同一个非空派系。 */
export function actorRepresentsObligor(
  actorId: string,
  obligorId: string,
  factionOfPrincipal: (principalId: string) => string | null,
): boolean {
  if (actorId === obligorId) {
    return true;
  }
  const actorFaction = factionOfPrincipal(actorId);
  return actorFaction !== null && actorFaction === factionOfPrincipal(obligorId);
}

/** 通行与水闸条款在义务期内仍可能违约，属于持续义务而不是一次性完成。 */
export function isSustainedTerm(term: Term): boolean {
  return term.kind === "grant-passage" || term.kind === "water-allocation";
}

/** 截至 `tick` 是否仍有未结束的持续义务；此时整份协议不能标为 fulfilled。 */
export function hasOpenSustainedObligation(state: AgreementState, tick: number): boolean {
  return state.terms.some(
    (term) => (term.kind === "grant-passage" || term.kind === "water-allocation") && term.untilTick >= tick,
  );
}

/**
 * 任务已完成，且完成 tick 落在协议生效 tick 之后、条款期限之内。
 * 完成 tick 缺失表示不是已提交的完成事实；生效前完成的任务不构成本协议的履约。
 */
function completedInWindow(task: TaskView, sinceTick: number, byTick: number): boolean {
  return task.completedAtTick !== null && task.completedAtTick >= sinceTick && task.completedAtTick <= byTick;
}

/**
 * 任务是否代表义务人：派遣者代表义务人，或执行任务队伍所属派系代表义务人。
 * 队伍按派系主体参与映射，因此普通角色义务人仍然只接受本人派遣。
 */
export function taskServesObligor(
  obligorId: string,
  task: TaskView,
  factions: FulfillmentFactions,
): boolean {
  if (actorRepresentsObligor(task.dispatcherId, obligorId, factions.factionOfPrincipal)) {
    return true;
  }
  const teamFaction = factions.factionOfTeam(task.teamId);
  return teamFaction !== null && actorRepresentsObligor(teamFaction, obligorId, factions.factionOfPrincipal);
}

/** 一条已完成任务是否满足条款要求的类型与参数；不判断期限与义务人。 */
export function taskMatchesTerm(term: Term, task: TaskView): boolean {
  if (term.kind === "deliver") {
    if (task.taskType !== "transport") {
      return false;
    }
    const params = task.params as {
      readonly fromStockpileId?: string;
      readonly toStockpileId?: string;
      readonly cargo?: Record<string, number>;
    };
    return (
      params.fromStockpileId === term.fromStockpileId &&
      params.toStockpileId === term.toStockpileId &&
      (params.cargo?.[term.resource] ?? 0) > 0
    );
  }
  if (term.kind === "escort") {
    return task.taskType === "escort" && (task.params as { readonly roadId?: string }).roadId === term.roadId;
  }
  if (term.kind === "rescue") {
    return task.taskType === "rescue" && (task.params as { readonly groupId?: string }).groupId === term.groupId;
  }
  if (term.kind === "repair-relay") {
    return task.taskType === "repair";
  }
  return false;
}

/** 运输任务 cargo 中该资源的数量；非正数与非法值按 0 计。 */
export function cargoAmount(task: TaskView, resource: ResourceId): number {
  const cargo = (task.params as { readonly cargo?: Record<string, number> }).cargo;
  const amount = cargo?.[resource] ?? 0;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * 条款是否已由协议生效之后、自身期限之前的已提交事实满足。
 * `sinceTick` 是协议生效 tick，早于它完成的任务或提交的分享不算履约；
 * 通行、水闸与委托条款生效即履约，通行与水闸的持续义务由调用方另行判定。
 */
export function isTermSatisfied(term: Term, facts: FulfillmentFacts, sinceTick: number): boolean {
  if (term.kind === "grant-passage" || term.kind === "water-allocation" || term.kind === "delegate") {
    return true;
  }
  if (term.kind === "share-evidence") {
    return facts.hasShare({
      fromId: term.obligorId,
      evidenceId: term.evidenceId,
      toPrincipalId: term.toPrincipalId,
      sinceTick,
      byTick: term.byTick,
    });
  }
  const matched = facts.completedTasks.filter(
    (task) =>
      completedInWindow(task, sinceTick, term.byTick) &&
      taskMatchesTerm(term, task) &&
      taskServesObligor(term.obligorId, task, facts),
  );
  if (term.kind === "deliver") {
    const delivered = matched.reduce((total, task) => total + cargoAmount(task, term.resource), 0);
    return delivered >= term.amount;
  }
  return matched.length > 0;
}

/**
 * 协议是否已全部条款满足且没有违约记录；判定期限是每条条款自己的截止 tick。
 * 未生效的协议还没有义务，不算满足；已记入 fulfilledTerms 的条款不再重复计算，
 * 其余条款按生效后的已提交事实复核；仍有未结束的持续义务时不算满足，与协议状态收尾规则保持一致。
 */
export function isAgreementSatisfied(state: AgreementState, facts: FulfillmentFacts, tick: number): boolean {
  const sinceTick = state.activatedAtTick;
  if (sinceTick === null || state.breachedTerms.length > 0 || hasOpenSustainedObligation(state, tick)) {
    return false;
  }
  return state.terms.every(
    (term, index) => state.fulfilledTerms.includes(index) || isTermSatisfied(term, facts, sinceTick),
  );
}
