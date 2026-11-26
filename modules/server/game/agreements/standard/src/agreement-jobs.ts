/**
 * 协议 job 处理器：提案到期关闭，以及期限到来时按已提交事实复核履约或违约并收尾。
 * 依赖协议聚合、履约判定、履约事实读取与世界/地图端口；不写任务或分享事实。
 * 禁止用未提交的异步消费者状态提前判定、把已记录的违约改回履约，或对已关闭协议重复处理。
 */
import { principalsAudience } from "@world-prism/module-sdk";
import type { Term } from "@world-prism/contracts";
import { isTermSatisfied } from "./fulfillment";
import { finishIfFulfilled, fulfillTerm, markBreach } from "./agreement-lifecycle";
import { asPorts, fulfillmentFacts, type AgreementContext } from "./agreement-shared";
import { readAgreementState } from "./state";

/** 提案到期：只关闭仍处于 proposed 的协议。 */
export function expire(context: AgreementContext, agreementId: string): void {
  const state = readAgreementState(context.tx, agreementId);
  if (state === null || state.status !== "proposed") {
    return;
  }
  context.tx.put("agreement", agreementId, { ...state, status: "expired" });
  context.tx.emit("AgreementExpired", { agreementId, byId: null }, principalsAudience(state.parties));
}

/** 通行与水闸的持续义务：义务期内义务人改了政策或关闭道路即为违约。 */
function sustainedObligationViolated(context: AgreementContext, term: Term): boolean {
  if (term.kind === "water-allocation") {
    return asPorts(context)["game.world"].meters()?.["watergate.allocation"] !== term.policy;
  }
  if (term.kind === "grant-passage") {
    return asPorts(context)["game.map"].roadStatus(term.roadId) === "closed";
  }
  return false;
}

/** 期限 job：先用已提交事实复核条款，满足即补记履约，否则记为违约并尝试收尾。 */
export function breach(context: AgreementContext, agreementId: string, termIndex: number): void {
  const state = readAgreementState(context.tx, agreementId);
  if (state === null) {
    return;
  }
  // eslint-disable-next-line security/detect-object-injection -- 索引来自 job payload 的条款序号，已由调度方限定为有效值。
  const term = state.terms[termIndex];
  if (term === undefined) {
    return;
  }
  let current = state;
  // 期限 job 可能先于消费者处理已提交的履约证据：先用生效后的已提交事实复核，满足即补记履约。
  // 生效前完成的任务或分享不算履约；期限 job 只在生效后安排，activatedAtTick 缺失时按 0 处理。
  if (
    sustainedObligationViolated(context, term) ||
    !isTermSatisfied(term, fulfillmentFacts(context), state.activatedAtTick ?? 0)
  ) {
    current = markBreach(context, current, termIndex);
  } else {
    current = fulfillTerm(context, current, termIndex, []);
  }
  finishIfFulfilled(context, current);
}
