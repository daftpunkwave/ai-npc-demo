/**
 * 协议 job 调度：提出时的到期检查、生效后的违约检查与协议关闭时的撤销，统一 job kind 与键格式。
 * 依赖协议状态与条款期限辅助、事务调度接口；不读取事实、不判定履约。
 * 禁止在协议状态变化之外直接增删上述 job，或复用别的协议 ID 作为 job 键。
 */
import { termDeadline } from "./terms";
import type { AgreementState } from "./state";
import type { AgreementContext } from "./agreement-shared";

/** 安排到期检查 job；提案与还价后的新协议各自持有独立键。 */
export function scheduleExpiry(context: AgreementContext, state: AgreementState): void {
  context.tx.schedule("agreement.expire", state.expiresAtTick, `agreement-expire:${state.agreementId}`, {
    agreementId: state.agreementId,
  });
}

/** 按条款安排违约检查；delegate 生效即履约，首版没有撤销命令，不安排违约检查。 */
export function scheduleBreaches(context: AgreementContext, state: AgreementState): void {
  for (const [index, term] of state.terms.entries()) {
    // 其余条款在期限 +1 的 job 上复核；通行与水闸的期限是 untilTick，该 job 同时负责收尾。
    if (term.kind === "delegate") {
      continue;
    }
    context.tx.schedule(
      "agreement.breach",
      termDeadline(term) + 1,
      `agreement-breach:${state.agreementId}:${index}`,
      { agreementId: state.agreementId, termIndex: index },
    );
  }
}

/** 撤销某份协议的全部到期与违约检查；拒绝、替代、履约收尾都经此出口。 */
export function cancelAgreementJobs(context: AgreementContext, state: AgreementState): void {
  context.tx.cancelJobs(`agreement-expire:${state.agreementId}`);
  context.tx.cancelJobs(`agreement-breach:${state.agreementId}`);
}
