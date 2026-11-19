/**
 * 实现协议查询端口：协议视图与截至指定 tick 的履约/违约计数。
 * 依赖协议聚合、本模块 scoped WorldTx，以及组合根注入的行动/通信/世界/地图只读端口。
 * 禁止在查询中改写协议、执行条款校验、触发履约事件或直接读取其他模块的私有聚合。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将泛型查询结果误判为 any。 */
import {
  type AgreementCounts,
  type AgreementQueryPorts,
  type AgreementView,
  type GameAgreementsPort,
  type OwnWorldTxFactory,
  type ShareQuery,
} from "@ai-npc/module-sdk";
import { isAgreementSatisfied, type FulfillmentFacts } from "./fulfillment";
import { readAgreementState, type AgreementState } from "./state";

function toView(state: AgreementState): AgreementView {
  return {
    agreementId: state.agreementId,
    version: state.version,
    proposerId: state.proposerId,
    status: state.status,
    parties: state.parties,
    terms: state.terms,
    createdAtTick: state.createdAtTick,
    expiresAtTick: state.expiresAtTick,
    supersedesId: state.supersedesId,
    fulfilledTerms: state.fulfilledTerms,
    breachedTerms: state.breachedTerms,
    progress: state.progress,
  };
}

/** 协议查询实现；统计时只读取当前事务内已提交的事实。 */
class StandardAgreementsPort implements GameAgreementsPort {
  private readonly ownTx: OwnWorldTxFactory;
  private readonly queries: AgreementQueryPorts;

  constructor(ownTx: OwnWorldTxFactory, queries: AgreementQueryPorts) {
    this.ownTx = ownTx;
    this.queries = queries;
  }

  private tx() {
    return this.ownTx();
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

  /**
   * 截至 `tick` 的同步统计：有违约记录或义务期内已违反持续义务的协议计一次违约；
   * 其余按生效后的已提交事实复核全部条款，全部满足才计为履约；
   * 未生效、仍有未满足条款或已关闭的提案不计。不读取消费进度，因此消费者滞后也能得到正确结果。
   */
  countsAsOf(tick: number): AgreementCounts {
    const facts = this.fulfillmentFacts();
    let fulfilled = 0;
    let breached = 0;
    for (const entry of this.tx().list<AgreementState>("agreement")) {
      const state = entry.state;
      if (state.activatedAtTick === null || state.activatedAtTick > tick) {
        continue;
      }
      // 政策事件尚未被消费者处理时，义务期内的水闸/道路状态也要在同一 tick 计入违约。
      if (state.breachedTerms.length > 0 || this.sustainedObligationViolated(state, tick)) {
        breached += 1;
        continue;
      }
      if (isAgreementSatisfied(state, facts, tick)) {
        fulfilled += 1;
      }
    }
    return { fulfilled, breached };
  }

  /**
   * 仍处于义务期的通行/水闸条款按当前世界状态复核：水闸分配不等于条款值或道路关闭即为违约。
   * 章节评估先于政策消费者运行时，这里直接给出已提交状态对应的违约，不依赖异步事件累计。
   */
  private sustainedObligationViolated(state: AgreementState, tick: number): boolean {
    const openTerms = state.terms.filter(
      (term) => (term.kind === "water-allocation" || term.kind === "grant-passage") && term.untilTick >= tick,
    );
    if (openTerms.length === 0) {
      return false;
    }
    // 世界指标尚未初始化时无法判定水闸义务；与注入的世界查询端口一致，按「未违约」处理。
    const allocation = this.queries.world.meters()?.["watergate.allocation"] ?? null;
    return openTerms.some((term) => {
      if (term.kind === "water-allocation") {
        return allocation !== null && allocation !== term.policy;
      }
      return term.kind === "grant-passage" && this.queries.map.roadStatus(term.roadId) === "closed";
    });
  }

  /** 履约事实：已完成任务、证据分享与队伍所属派系全部经注入的 typed port 读取。 */
  private fulfillmentFacts(): FulfillmentFacts {
    const teams = new Map(this.queries.world.teams().map((team) => [team.teamId, team.ownerFactionId]));
    return {
      completedTasks: this.queries.actions.completedTasks(),
      hasShare: (query: ShareQuery) => this.queries.comms.hasShare(query),
      factionOfTeam: (teamId) => teams.get(teamId) ?? null,
    };
  }
}

/** 构造绑定到当前事务的协议端口；queries 由组合根按依赖顺序注入。 */
export function createAgreementsPort(
  ownTx: OwnWorldTxFactory,
  queries: AgreementQueryPorts,
): GameAgreementsPort {
  return new StandardAgreementsPort(ownTx, queries);
}
