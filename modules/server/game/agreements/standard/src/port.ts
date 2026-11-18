/**
 * 实现协议查询端口，供剧情与运营读取协议状态。
 * 依赖协议聚合与 scoped WorldTx；不执行条款校验或状态迁移。
 * 禁止在查询中改写协议或触发履约事件。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将泛型查询结果误判为 any。 */
import {
  gameModuleIds,
  type AgreementView,
  type GameAgreementsPort,
  type ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import { readAgreementState, type AgreementState } from "./state";

function toView(state: NonNullable<ReturnType<typeof readAgreementState>>): AgreementView {
  return {
    agreementId: state.agreementId,
    status: state.status,
    parties: state.parties,
  };
}

/** 协议查询实现；只读当前事务内的 agreement 聚合。 */
class StandardAgreementsPort implements GameAgreementsPort {
  private readonly txFor: ScopedWorldTxFactory;

  constructor(txFor: ScopedWorldTxFactory) {
    this.txFor = txFor;
  }

  private tx() {
    return this.txFor(gameModuleIds.agreements);
  }

  agreement(agreementId: string): AgreementView | null {
    const state = readAgreementState(this.tx(), agreementId);
    return state === null ? null : toView(state);
  }

  agreementsOf(principalId: string): readonly AgreementView[] {
    return this.tx()
      .list<AgreementState>("agreement")
      .map((entry) => entry.state)
      .filter((state) => state.parties.includes(principalId))
      .map(toView);
  }

  activeAgreements(): readonly AgreementView[] {
    return this.tx()
      .list<AgreementState>("agreement")
      .map((entry) => entry.state)
      .filter((state) => state.status === "active")
      .map(toView);
  }
}

/** 构造绑定到当前事务的协议端口。 */
export function createAgreementsPort(txFor: ScopedWorldTxFactory): GameAgreementsPort {
  return new StandardAgreementsPort(txFor);
}
