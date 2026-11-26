/**
 * 核心职责：从协议端口构建玩家是当事人的协议视图，含逐条状态与累计进度。
 * 交互契约：依赖协议端口的协议视图与世界协议计数词表。
 * 约束与禁忌：只输出玩家是当事人的协议；条款状态判定只依据端口已提交事实。
 */
import type { AgreementView } from "@world-prism/contracts";
import type { AgreementView as AgreementPortView, GameAgreementsPort } from "@world-prism/module-sdk";

function termStatus(agreement: AgreementPortView, index: number): "open" | "fulfilled" | "breached" {
  if (agreement.breachedTerms.includes(index)) {
    return "breached";
  }
  return agreement.fulfilledTerms.includes(index) ? "fulfilled" : "open";
}

/** 协议：只给玩家是当事人的协议，含逐条状态与累计进度。 */
export function agreementViews(
  agreements: GameAgreementsPort | undefined,
  playerPrincipalId: string,
): AgreementView[] {
  if (agreements === undefined) {
    return [];
  }
  return agreements
    .agreementsOf(playerPrincipalId)
    .map((agreement) => ({
      agreementId: agreement.agreementId,
      version: agreement.version,
      proposerId: agreement.proposerId,
      parties: [...agreement.parties],
      terms: agreement.terms.map((term, index) => ({
        term,
        status: termStatus(agreement, index),
        progress: agreement.progress.at(index) ?? null,
      })),
      status: agreement.status,
      expiresAtTick: agreement.expiresAtTick,
      supersedesId: agreement.supersedesId,
    }))
    .sort((left, right) => left.agreementId.localeCompare(right.agreementId));
}
