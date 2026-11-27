/**
 * 核心职责：实现世界端口的委托操作：跨多份委托扣减、按记录回补与创建新委托。
 * 交互契约：依赖注入的 scoped WorldTx、ID 生成器与查询片段的委托查找。
 * 约束与禁忌：禁止按主体与库存点重新查找已扣减委托；回补不得超过委托上限。
 */
import type { ResourceAmounts } from "@world-prism/contracts";
import {
  factionAudience,
  principalsAudience,
  subtractAmounts,
  totalAmount,
  addAmounts,
  type DelegationAllocation,
  type GameIdFactory,
  type GameWorldPort,
  type ScopedWorldTxFactory,
} from "@world-prism/module-sdk";
import { worldModuleDefinition } from "./definition";
import { failure, type OpFailure, type OpSuccess } from "./port-result";
import type { WorldQueries } from "./port-queries";
import {
  delegationStateSchema,
  readWorldState,
  type DelegationState,
} from "./state";

interface PlannedDelegationDraw {
  readonly delegation: DelegationState;
  readonly amount: ResourceAmounts;
}

function planDelegationDraws(
  candidates: readonly DelegationState[],
  delta: ResourceAmounts,
): readonly PlannedDelegationDraw[] | null {
  let remainingNeed = delta;
  const draws: PlannedDelegationDraw[] = [];
  for (const delegation of candidates) {
    const amount: ResourceAmounts = {
      supply: Math.min(delegation.remaining.supply, remainingNeed.supply),
      energy: Math.min(delegation.remaining.energy, remainingNeed.energy),
      medical: Math.min(delegation.remaining.medical, remainingNeed.medical),
    };
    if (totalAmount(amount) === 0) {
      continue;
    }
    draws.push({ delegation, amount });
    remainingNeed = subtractAmounts(remainingNeed, amount);
    if (totalAmount(remainingNeed) === 0) {
      return draws;
    }
  }
  return null;
}

/** 世界端口委托操作的依赖：调用方作用域事务工厂、ID 生成器与查询片段。 */
export interface WorldDelegationOpsDeps {
  readonly txFor: ScopedWorldTxFactory;
  readonly ids: GameIdFactory;
  readonly queries: Pick<WorldQueries, "findDelegations">;
}

export function createWorldDelegationOps({ txFor, ids, queries }: WorldDelegationOpsDeps): Pick<
  GameWorldPort,
  "drawDelegation" | "refundDelegation" | "createDelegation"
> {
  const tx = () => txFor(worldModuleDefinition.id);
  return {
    drawDelegation(
      principalId: string,
      stockpileId: string,
      delta: ResourceAmounts,
    ): { readonly ok: true; readonly delegationId: string; readonly allocations: readonly DelegationAllocation[] } | OpFailure {
      const candidates = queries.findDelegations(principalId, stockpileId).map((entry) => entry.state);
      if (candidates.length === 0) {
        return failure("draw-limit-exceeded");
      }
      const first = candidates[0] as DelegationState;
      if (totalAmount(delta) === 0) {
        return { ok: true, delegationId: first.delegationId, allocations: [] };
      }
      const plannedDraws = planDelegationDraws(candidates, delta);
      if (plannedDraws === null || plannedDraws.length === 0) {
        return failure("draw-limit-exceeded");
      }
      for (const draw of plannedDraws) {
        tx().put("delegation", draw.delegation.delegationId, {
          ...draw.delegation,
          remaining: subtractAmounts(draw.delegation.remaining, draw.amount),
        });
      }
      const allocations: readonly DelegationAllocation[] = plannedDraws.map((draw) => ({
        delegationId: draw.delegation.delegationId,
        amount: draw.amount,
      }));
      const firstAllocation = allocations[0];
      if (firstAllocation === undefined) {
        return failure("draw-limit-exceeded");
      }
      // 保留稳定的单委托 ID 字段供兼容调用；回补方使用 allocations 逐笔处理所有已扣减委托。
      return { ok: true, delegationId: firstAllocation.delegationId, allocations };
    },

    refundDelegation(delegationId: string, delta: ResourceAmounts): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "delegation", delegationId, delegationStateSchema);
      if (record === null) {
        return failure("invalid-params");
      }
      const delegation = record.state;
      const next = addAmounts(delegation.remaining, delta);
      tx().put("delegation", delegation.delegationId, {
        ...delegation,
        remaining: {
          supply: Math.min(next.supply, delegation.limit.supply),
          energy: Math.min(next.energy, delegation.limit.energy),
          medical: Math.min(next.medical, delegation.limit.medical),
        },
      });
      return { ok: true };
    },

    createDelegation(spec: {
      readonly grantorFactionId: string;
      readonly granteeId: string;
      readonly teamIds: readonly string[];
      readonly stockpileId: string | null;
      readonly maxDraw: ResourceAmounts;
      readonly untilTick: number;
    }): { readonly ok: true; readonly delegationId: string } {
      const delegationId = ids("del");
      const state: DelegationState = {
        delegationId,
        grantorFactionId: spec.grantorFactionId,
        granteeId: spec.granteeId,
        teamIds: [...spec.teamIds],
        stockpileId: spec.stockpileId,
        remaining: spec.maxDraw,
        limit: spec.maxDraw,
        untilTick: spec.untilTick,
      };
      tx().put("delegation", delegationId, state);
      tx().emit(
        "DelegationCreated",
        {
          delegationId,
          grantorFactionId: spec.grantorFactionId,
          granteeId: spec.granteeId,
          teamIds: [...spec.teamIds],
          stockpileId: spec.stockpileId,
          maxDraw: spec.maxDraw,
          untilTick: spec.untilTick,
        },
        [...principalsAudience([spec.granteeId]), factionAudience(spec.grantorFactionId)],
      );
      return { ok: true, delegationId };
    },
  };
}
