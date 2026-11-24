/**
 * 核心职责：按节点整理地点页签要展示的人员数量与库存条目，供视图直接渲染。
 * 交互契约：输入玩家投影，返回与 map.nodes 同序的行，每行带该节点的人数和库存；
 *   人数为属于该节点的角色数量，库存为属于该节点的库存条目，与逐节点筛选结果一致。
 * 约束与禁忌：只做归类与计数，不筛选节点、不排序、不改写条目；
 *   禁止在此读取世界状态、发起请求或产生副作用。
 */
import type { CharacterView, PlayerProjection, StockpileView } from "@ai-npc/contracts";
import { groupByNodeId } from "./node-index";

/** 地点页签的一行：节点身份、该节点在场人数与库存条目。 */
export interface PlaceRow {
  readonly nodeId: string;
  readonly name: string;
  readonly facilities: readonly string[];
  readonly people: readonly CharacterView[];
  readonly stockpiles: readonly StockpileView[];
}

const NO_PEOPLE: readonly CharacterView[] = [];
const NO_STOCKPILES: readonly StockpileView[] = [];

/**
 * 建立地点页签的数据行。
 * 每个集合只遍历一次再按节点查找，避免逐节点重扫全量库存与角色。
 */
export function placeRows(projection: PlayerProjection): readonly PlaceRow[] {
  const stockpilesByNode = groupByNodeId(projection.stockpiles);
  const peopleByNode = groupByNodeId(projection.characters);
  return projection.map.nodes.map((node) => ({
    nodeId: node.nodeId,
    name: node.name,
    facilities: node.facilities,
    people: peopleByNode.get(node.nodeId) ?? NO_PEOPLE,
    stockpiles: stockpilesByNode.get(node.nodeId) ?? NO_STOCKPILES,
  }));
}
