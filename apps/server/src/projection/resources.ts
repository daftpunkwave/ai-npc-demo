/**
 * 核心职责：从资源端口与委托余额构建库存点的玩家可见视图。
 * 交互契约：依赖内容索引、资源端口与世界端口委托视图；资源聚合未初始化时输出空集合。
 * 约束与禁忌：精确数量与委托余额只给仍持有委托的玩家，禁止按内容初值伪造资源事实。
 */
import type { StockpileView } from "@world-prism/contracts";
import { addAmounts } from "@world-prism/module-sdk";
import type { GameContent, GameResourcesPort, GameWorldPort } from "@world-prism/module-sdk";

/**
 * 库存点：等级公开；精确数量与委托余额只给当前仍持有该库存点委托的玩家。
 * 资源聚合尚未初始化时（开局前）没有精确事实，直接输出空集合，不按内容初值伪造。
 */
export function stockpileViews(input: {
  readonly content: GameContent;
  readonly resources: GameResourcesPort | undefined;
  readonly delegations: ReturnType<GameWorldPort["delegationsOf"]>;
  readonly tick: number;
}): StockpileView[] {
  const { content, resources, delegations, tick } = input;
  if (resources === undefined) {
    return [];
  }
  const views: StockpileView[] = [];
  for (const init of content.stockpiles.values()) {
    const stockpile = resources.stockpile(init.stockpileId);
    if (stockpile === null) {
      continue;
    }
    const activeDelegations = delegations.filter(
      (candidate) => candidate.stockpileId === init.stockpileId && candidate.untilTick >= tick,
    );
    const delegation =
      activeDelegations.length === 0
        ? null
        : {
            remaining: activeDelegations.reduce(
              (remaining, candidate) => addAmounts(remaining, candidate.remaining),
              { supply: 0, energy: 0, medical: 0 },
            ),
            untilTick: Math.min(...activeDelegations.map((candidate) => candidate.untilTick)),
          };
    const levels = resources.level(init.stockpileId);
    views.push({
      stockpileId: stockpile.stockpileId,
      nodeId: stockpile.nodeId,
      ownerFactionId: stockpile.ownerFactionId,
      supplyLevel: levels.supply,
      energyLevel: levels.energy,
      medicalLevel: levels.medical,
      amounts: delegation === null ? null : stockpile.amount,
      delegation,
    });
  }
  return views.sort((left, right) => left.stockpileId.localeCompare(right.stockpileId));
}
