/**
 * 按条款判断「截至期限是否已由已提交事实满足」，供协议事件消费、期限 job 与章节统计共用。
 * 依赖公共条款、行动模块的任务视图与协议聚合状态；全部函数同步且无副作用。
 * 禁止用消费时钟、未提交事实或期限之后的完成来判定履约，也禁止在这里写聚合或发事件。
 */
import type { ResourceId, Term } from "@ai-npc/contracts";
import type { ShareQuery, TaskView } from "@ai-npc/module-sdk";
import type { AgreementState } from "./state";

/** 履约事实来源：已完成任务、证据分享查询与队伍所属派系解析。 */
export interface FulfillmentFacts {
  readonly completedTasks: readonly TaskView[];
  readonly hasShare: (query: ShareQuery) => boolean;
  readonly factionOfTeam: (teamId: string) => string | null;
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

/** 任务已完成且完成 tick 不晚于期限；完成 tick 缺失表示不是已提交的完成事实。 */
function completedBy(task: TaskView, byTick: number): boolean {
  return task.completedAtTick !== null && task.completedAtTick <= byTick;
}

/** 任务由义务人派遣，或由义务人派系的队伍执行。 */
export function taskServesObligor(
  obligorId: string,
  task: TaskView,
  factionOfTeam: (teamId: string) => string | null,
): boolean {
  return task.dispatcherId === obligorId || factionOfTeam(task.teamId) === obligorId;
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
 * 条款是否已由截至自身期限的已提交事实满足。
 * 通行、水闸与委托条款生效即履约；通行与水闸的持续义务由调用方另行判定。
 */
export function isTermSatisfied(term: Term, facts: FulfillmentFacts): boolean {
  if (term.kind === "grant-passage" || term.kind === "water-allocation" || term.kind === "delegate") {
    return true;
  }
  if (term.kind === "share-evidence") {
    return facts.hasShare({
      fromId: term.obligorId,
      evidenceId: term.evidenceId,
      toPrincipalId: term.toPrincipalId,
      byTick: term.byTick,
    });
  }
  const matched = facts.completedTasks.filter(
    (task) =>
      completedBy(task, term.byTick) &&
      taskMatchesTerm(term, task) &&
      taskServesObligor(term.obligorId, task, facts.factionOfTeam),
  );
  if (term.kind === "deliver") {
    const delivered = matched.reduce((total, task) => total + cargoAmount(task, term.resource), 0);
    return delivered >= term.amount;
  }
  return matched.length > 0;
}

/**
 * 协议是否已全部条款满足且没有违约记录；判定期限是每条条款自己的截止 tick。
 * 已记入 fulfilledTerms 的条款不再重复计算，其余条款按已提交事实复核；
 * 仍有未结束的持续义务时不算满足，与协议状态收尾规则保持一致。
 */
export function isAgreementSatisfied(state: AgreementState, facts: FulfillmentFacts, tick: number): boolean {
  if (state.breachedTerms.length > 0 || hasOpenSustainedObligation(state, tick)) {
    return false;
  }
  return state.terms.every(
    (term, index) => state.fulfilledTerms.includes(index) || isTermSatisfied(term, facts),
  );
}
