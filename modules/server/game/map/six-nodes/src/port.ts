/**
 * 实现 game.map 的只读查询与道路/通行许可写入，包括按规则排序的 Dijkstra 路径，
 * 以及地图拥有的 policy.set 政策键（道路状态）的解析、校验与执行。
 * 依赖内容视图、地图聚合状态与注入的 scoped WorldTx；所有写入与事件都进入调用方事务。
 * 禁止读取其他模块聚合、使用 Math.random 决定路径或在未受控道路上伪造控制权。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { ReasonCode, RoadStatus } from "@world-prism/contracts";
import { DomainError, roadIdFromPolicyKey, roadStatusPolicyKey, roadStatusSchema } from "@world-prism/contracts";
import {
  findRoadPath,
  type GameContent,
  type GameIdFactory,
  type GameMapPort,
  type GameRoad,
  type MapPolicyOutcome,
  type RouteQuery,
  type RouteResult,
  type ScopedWorldTxFactory,
} from "@world-prism/module-sdk";
import { mapModuleDefinition } from "./definition";
import { passageGrantStateSchema, readMapState, roadStateSchema, type PassageGrantState } from "./state";

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
    return this.txFor(mapModuleDefinition.id);
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
    return findRoadPath(this.content.nodes, this.content.roads.values(), query,
      (road) => this.canUse(road, query.factionId, query.atTick));
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
      { key: roadStatusPolicyKey(roadId), oldValue: oldStatus ?? "open", newValue: status, byId },
      [{ kind: "public" }],
    );
    return { ok: true };
  }

  applyPolicy(key: string, value: string, byId: string): MapPolicyOutcome | null {
    const roadId = roadIdFromPolicyKey(key);
    if (roadId === null) {
      return null;
    }
    if (!this.content.roads.has(roadId)) {
      return { ok: false, reasonCode: "unknown-policy", safeMessage: "道路不存在" };
    }
    const status = roadStatusSchema.safeParse(value);
    if (!status.success) {
      return { ok: false, reasonCode: "unknown-policy", safeMessage: "未知的道路状态" };
    }
    const oldValue = this.roadStatus(roadId) ?? "open";
    const result = this.setRoadStatus(roadId, status.data, byId);
    if (!result.ok) {
      return { ok: false, reasonCode: result.reasonCode, safeMessage: "道路状态未改变" };
    }
    return { ok: true, oldValue, newValue: status.data };
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
