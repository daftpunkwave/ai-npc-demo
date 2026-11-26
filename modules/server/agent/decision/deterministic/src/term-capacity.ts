/**
 * 核对同一提案的定量资源条款是否在当前委托余额内。
 * 使用冻结的库存点、资源类型、期限和委托余额。
 * 不扣减库存或取代协议提交时的权威校验。
 */
import type { ResourceAmounts, Term } from "@world-prism/contracts";
import type { DeterministicDecisionInput } from "@world-prism/module-sdk";

export function termsWithinDelegations(terms: readonly Term[], input: DeterministicDecisionInput): boolean {
  const remaining = new Map<string, ResourceAmounts>();
  for (const delegation of input.self.delegations) {
    if (delegation.stockpileId === null || delegation.untilTick < input.frontier.worldTick) continue;
    const previous = remaining.get(delegation.stockpileId);
    remaining.set(delegation.stockpileId, {
      supply: (previous?.supply ?? 0) + delegation.remaining.supply,
      energy: (previous?.energy ?? 0) + delegation.remaining.energy,
      medical: (previous?.medical ?? 0) + delegation.remaining.medical,
    });
  }
  for (const term of terms) {
    const stockpileId = term.kind === "deliver" ? term.fromStockpileId : term.kind === "delegate" ? term.stockpileId : null;
    if (stockpileId === null) continue;
    const required = term.kind === "deliver"
      ? { supply: 0, energy: 0, medical: 0, [term.resource]: term.amount }
      : term.kind === "delegate" ? term.maxDraw : null;
    if (required === null) continue;
    const balance = remaining.get(stockpileId);
    if (balance === undefined || balance.supply < required.supply ||
      balance.energy < required.energy || balance.medical < required.medical) return false;
    remaining.set(stockpileId, {
      supply: balance.supply - required.supply,
      energy: balance.energy - required.energy,
      medical: balance.medical - required.medical,
    });
  }
  return true;
}
