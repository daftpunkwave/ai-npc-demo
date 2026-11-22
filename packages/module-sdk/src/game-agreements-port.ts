/**
 * 核心职责：定义协议模块的游戏端口与协议视图、章节计数类型。
 * 交互契约：依赖公共契约的条款类型；端口查询返回协议状态与履约进度。
 * 约束与禁忌：禁止在这里实现规则或读取协议模块之外的聚合。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type { Term } from "@ai-npc/contracts";

/** 协议查询端口；条款状态由协议模块拥有。 */
export interface AgreementView {
  readonly agreementId: string;
  readonly version: number;
  readonly proposerId: string;
  readonly status: "proposed" | "active" | "fulfilled" | "rejected" | "superseded" | "expired" | "breached";
  readonly parties: readonly string[];
  readonly terms: readonly Term[];
  readonly createdAtTick: number;
  readonly expiresAtTick: number;
  readonly supersedesId: string | null;
  /** 已履约与已违约的条款下标；其余条款状态为 open。 */
  readonly fulfilledTerms: readonly number[];
  readonly breachedTerms: readonly number[];
  /** 与 terms 同下标的累计进度；没有进度概念的条款为 0。 */
  readonly progress: readonly number[];
}

/** 截至某个 tick 的协议计数；同一协议只计一次，供章节评估使用。 */
export interface AgreementCounts {
  readonly fulfilled: number;
  readonly breached: number;
}

/** 协议查询端口；协议聚合由协议模块拥有。 */
export interface GameAgreementsPort {
  agreement(agreementId: string): AgreementView | null;
  agreementsOf(principalId: string): readonly AgreementView[];
  activeAgreements(): readonly AgreementView[];
  /**
   * 按已提交事实同步统计截至 `tick` 的已履约与已违约协议数：有违约记录的计入 breached，
   * 全部条款（含期限复核）满足且无违约的计入 fulfilled，未生效或仍有未满足条款的不计。
   */
  countsAsOf(tick: number): AgreementCounts;
}
