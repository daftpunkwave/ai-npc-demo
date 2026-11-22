/**
 * 在调用方提供的道路集合内寻找最短路线，并稳定处理同成本路径。
 * 通行条件由权威规则或冻结的已知视图分别提供。
 * 禁止自行读取世界状态、授予通行许可或改变路径成本。
 */
import type { GameRoad, RouteQuery, RouteResult } from "./game-ports";

interface PathCandidate {
  readonly nodeId: string;
  readonly cost: number;
  readonly roadIds: readonly string[];
}

function comparePaths(left: PathCandidate, right: PathCandidate): number {
  if (left.cost !== right.cost) {
    return left.cost - right.cost;
  }
  if (left.roadIds.length !== right.roadIds.length) {
    return left.roadIds.length - right.roadIds.length;
  }
  return left.roadIds.join("\u0000").localeCompare(right.roadIds.join("\u0000"));
}

function pushAdjacent(adjacency: Map<string, { readonly road: GameRoad; readonly to: string }[]>, road: GameRoad): void {
  const forward = adjacency.get(road.a) ?? [];
  forward.push({ road, to: road.b });
  adjacency.set(road.a, forward);
  const backward = adjacency.get(road.b) ?? [];
  backward.push({ road, to: road.a });
  adjacency.set(road.b, backward);
}

export function findRoadPath(
  nodes: ReadonlyMap<string, unknown>,
  roads: Iterable<GameRoad>,
  query: Pick<RouteQuery, "fromNodeId" | "toNodeId" | "withCargo">,
  canUse: (road: GameRoad) => boolean,
): RouteResult | null {
  if (!nodes.has(query.fromNodeId) || !nodes.has(query.toNodeId)) {
    return null;
  }
  if (query.fromNodeId === query.toNodeId) {
    return { roadIds: [], travelTicks: 0 };
  }
  const adjacency = new Map<string, { readonly road: GameRoad; readonly to: string }[]>();
  for (const road of roads) {
    pushAdjacent(adjacency, road);
  }
  const best = new Map<string, PathCandidate>();
  const settled = new Set<string>();
  best.set(query.fromNodeId, { nodeId: query.fromNodeId, cost: 0, roadIds: [] });
  while (settled.size < nodes.size) {
    let current: PathCandidate | undefined;
    for (const candidate of best.values()) {
      if (settled.has(candidate.nodeId)) {
        continue;
      }
      if (current === undefined || comparePaths(candidate, current) < 0) {
        current = candidate;
      }
    }
    if (current === undefined) {
      break;
    }
    if (current.nodeId === query.toNodeId) {
      return { roadIds: [...current.roadIds], travelTicks: current.cost };
    }
    settled.add(current.nodeId);
    for (const edge of adjacency.get(current.nodeId) ?? []) {
      if (settled.has(edge.to) || !canUse(edge.road)) {
        continue;
      }
      const next: PathCandidate = {
        nodeId: edge.to,
        cost: current.cost + edge.road.travelTicks + (query.withCargo ? 1 : 0),
        roadIds: [...current.roadIds, edge.road.roadId],
      };
      const existing = best.get(edge.to);
      if (existing === undefined || comparePaths(next, existing) < 0) {
        best.set(edge.to, next);
      }
    }
  }
  return null;
}
