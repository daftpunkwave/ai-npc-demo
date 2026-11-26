/**
 * 协议状态转换：条款履约/违约记录、义务期判断与整份协议收尾。
 * 依赖协议聚合状态、履约辅助与公共受众类型；不读取命令载荷、不安排 job。
 * 禁止把已记录的违约回退为履约、在义务期未结束时整体标为 fulfilled，或基于旧状态覆盖新状态。
 */
import { principalsAudience } from "@world-prism/module-sdk";
import type { AgreementState } from "./state";
import { hasOpenSustainedObligation, isSustainedTerm } from "./fulfillment";
import { cancelAgreementJobs } from "./agreement-schedule";
import type { AgreementContext } from "./agreement-shared";

/** 义务期尚未结束的通行/水闸条款仍可能违约，协议此时不能整体标为 fulfilled。 */
function hasOpenObligation(context: AgreementContext, state: AgreementState): boolean {
  return hasOpenSustainedObligation(state, context.tx.worldTick);
}

/** 全部条款履约且没有未结束的持续义务时收尾；已违约或已关闭的协议不再改写。 */
export function finishIfFulfilled(context: AgreementContext, state: AgreementState): AgreementState {
  // 只有仍然生效的协议能收尾；已违约或已关闭的协议不再被后续履约改写。
  if (state.status !== "active") {
    return state;
  }
  if (state.fulfilledTerms.length !== state.terms.length || hasOpenObligation(context, state)) {
    return state;
  }
  const fulfilled: AgreementState = { ...state, status: "fulfilled" };
  context.tx.put("agreement", fulfilled.agreementId, fulfilled);
  context.tx.emit("AgreementFulfilled", { agreementId: fulfilled.agreementId }, principalsAudience(fulfilled.parties));
  cancelAgreementJobs(context, fulfilled);
  return fulfilled;
}

/**
 * 记录一条条款违约并返回最新状态。
 * 同一事件可能命中同一协议的多条条款，调用方必须串联返回值，不能各自基于旧状态写入。
 */
export function markBreach(context: AgreementContext, state: AgreementState, index: number): AgreementState {
  if (state.status !== "active" && state.status !== "breached" && state.status !== "fulfilled") {
    return state;
  }
  if (state.breachedTerms.includes(index)) {
    return state;
  }
  // eslint-disable-next-line security/detect-object-injection -- 索引来自本文件的条款遍历，不来自外部输入。
  const term = state.terms[index];
  if (term === undefined) {
    return state;
  }
  // 通行与水闸条款生效即记为履约，但义务期内的违反仍要记录；其余条款履约后不再违约。
  if (state.fulfilledTerms.includes(index) && !isSustainedTerm(term)) {
    return state;
  }
  const next: AgreementState = {
    ...state,
    status: "breached",
    breachedTerms: [...state.breachedTerms, index],
    fulfilledTerms: state.fulfilledTerms.filter((value) => value !== index),
  };
  context.tx.put("agreement", next.agreementId, next);
  context.tx.emit(
    "AgreementBreached",
    { agreementId: next.agreementId, termIndex: index, obligorId: term.obligorId, term },
    principalsAudience(next.parties),
  );
  return next;
}

/** 记录一条条款履约并尝试收尾；已关闭的协议不再新增履约记录。 */
export function fulfillTerm(
  context: AgreementContext,
  state: AgreementState,
  index: number,
  evidenceEventIds: readonly string[],
): AgreementState {
  // 已关闭的协议不再记录新的履约；已记录的违约是不可回退的事实，后续履约证据不能把它改写成履约。
  if (state.status !== "active" && state.status !== "breached") {
    return state;
  }
  if (state.fulfilledTerms.includes(index) || state.breachedTerms.includes(index)) {
    return state;
  }
  // eslint-disable-next-line security/detect-object-injection -- 索引来自本文件的条款遍历，不来自外部输入。
  const term = state.terms[index];
  if (term === undefined) {
    return state;
  }
  const next: AgreementState = {
    ...state,
    fulfilledTerms: [...state.fulfilledTerms, index],
  };
  context.tx.put("agreement", next.agreementId, next);
  context.tx.emit(
    "AgreementTermFulfilled",
    { agreementId: next.agreementId, termIndex: index, obligorId: term.obligorId, term, evidenceEventIds: [...evidenceEventIds] },
    principalsAudience(next.parties),
  );
  return finishIfFulfilled(context, next);
}
