/**
 * 实现 game.map 的只读查询与道路/通行许可写入，包括按规则排序的 Dijkstra 路径。
 * 依赖内容视图、地图聚合状态与注入的 scoped WorldTx；所有写入与事件都进入调用方事务。
 * 禁止读取其他模块聚合、使用 Math.random 决定路径或在未受控道路上伪造控制权。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { ReasonCode, RoadStatus } from "@ai-npc/contracts";
import { DomainError } from "@ai-npc/contracts";
import {
  gameModuleIds,
  type GameContent,
  type GameIdFactory,
  type GameMapPort,
  type GameRoad,
  type RouteQuery,
  type RouteResult,
  type ScopedWorldTxFactory,
} from "@ai-npc/module-sdk";
import { passageGrantStateSchema, readMapState, roadStateSchema, type PassageGrantState } from "./state";

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

/** 地图端口实现；生命周期随一次处理器调用，构造后不跨事务复用。 */
class SixNodeMapPort implements GameMapPort {
  private readonly txFor: ScopedWorldTxFactory;
  private readonly content: GameContent;
  private readonly ids: GameIdFactory;

  constructor(txFor: ScopedWorldTxFactory, content: GameContent, ids: GameIdFactory) {
    this.txFor = txFor;
    this.content = content;
    this.ids = ids;
  }

  private tx() {
    return this.txFor(gameModuleIds.map);
  }

  road(roadId: string): GameRoad | null {
    return this.content.roads.get(roadId) ?? null;
  }

  roadStatus(roadId: string): RoadStatus | null {
    const road = this.content.roads.get(roadId);
    if (road === undefined) {
      return null;
    }
    const stored = readMapState(this.tx(), "road", roadId, roadStateSchema);
    return stored?.state.status ?? road.initialStatus ?? "open";
  }

  hasPassage(roadId: string, factionId: string, atTick: number): boolean {
    for (const entry of this.tx().list<unknown>("passage-grant")) {
      const parsed = passageGrantStateSchema.safeParse(entry.state);
      if (!parsed.success) {
        throw new DomainError("invalid-state", `通行许可 ${entry.id} 不合法`, { details: { grantId: entry.id } });
      }
      const grant = parsed.data;
      if (grant.roadId === roadId && grant.granteeFactionId === factionId && grant.untilTick >= atTick) {
        return true;
      }
    }
    return false;
  }

  private canUse(road: GameRoad, factionId: string, atTick: number): boolean {
    const status = this.roadStatus(road.roadId);
    if (status === null || status === "closed") {
      return false;
    }
    if (status === "open") {
      return true;
    }
    if (road.controlledBy === factionId) {
      return true;
    }
    return this.hasPassage(road.roadId, factionId, atTick);
  }

  findRoute(query: RouteQuery): RouteResult | null {
    if (!this.content.nodes.has(query.fromNodeId) || !this.content.nodes.has(query.toNodeId)) {
      return null;
    }
    if (query.fromNodeId === query.toNodeId) {
      return { roadIds: [], travelTicks: 0 };
    }
    const adjacency = new Map<string, { readonly road: GameRoad; readonly to: string }[]>();
    for (const road of this.content.roads.values()) {
      pushAdjacent(adjacency, road);
    }
    const best = new Map<string, PathCandidate>();
    const settled = new Set<string>();
    best.set(query.fromNodeId, { nodeId: query.fromNodeId, cost: 0, roadIds: [] });
    while (settled.size < this.content.nodes.size) {
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
        if (settled.has(edge.to) || !this.canUse(edge.road, query.factionId, query.atTick)) {
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

  setRoadStatus(
    roadId: string,
    status: RoadStatus,
    byId: string,
    force = false,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode } {
    const road = this.content.roads.get(roadId);
    if (road === undefined) {
      return { ok: false, reasonCode: "unknown-policy" };
    }
    if (!force && road.controlledBy !== byId) {
      return { ok: false, reasonCode: "no-authority" };
    }
    const oldStatus = this.roadStatus(roadId);
    if (oldStatus === status) {
      return { ok: false, reasonCode: "no-change" };
    }
    this.tx().put("road", roadId, { roadId, status });
    this.tx().emit(
      "PolicyChanged",
      { key: `road.status:${roadId}`, oldValue: oldStatus ?? "open", newValue: status, byId },
      [{ kind: "public" }],
    );
    return { ok: true };
  }

  grantPassage(input: {
    readonly roadId: string;
    readonly granteeFactionId: string;
    readonly untilTick: number;
    readonly byId: string;
  }): { readonly ok: true; readonly grantId: string } | { readonly ok: false; readonly reasonCode: ReasonCode } {
    const road = this.content.roads.get(input.roadId);
    if (road === undefined) {
      return { ok: false, reasonCode: "unknown-policy" };
    }
    if (road.controlledBy !== input.byId) {
      return { ok: false, reasonCode: "no-authority" };
    }
    const created = this.ids("pg");
    const state: PassageGrantState = {
      roadId: input.roadId,
      granteeFactionId: input.granteeFactionId,
      untilTick: input.untilTick,
    };
    this.tx().put("passage-grant", created, state);
    this.tx().emit(
      "PassageGranted",
      {
        grantId: created,
        roadId: input.roadId,
        granteeFactionId: input.granteeFactionId,
        untilTick: input.untilTick,
      },
      [{ kind: "public" }],
    );
    return { ok: true, grantId: created };
  }
}

/** 构造绑定到当前事务的地图端口；内容索引只读，不复制道路状态。 */
export function createMapPort(
  txFor: ScopedWorldTxFactory,
  content: GameContent,
  ids: GameIdFactory,
): GameMapPort {
  return new SixNodeMapPort(txFor, content, ids);
}
