/**
 * 核心职责：定义地图模块的游戏端口与路径查询类型。
 * 交互契约：依赖公共契约的道路状态与原因码；端口读写绑定调用方世界事务。
 * 约束与禁忌：禁止在这里实现寻路规则或读取地图模块之外的聚合。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type { ReasonCode, RoadStatus } from "@world-prism/contracts";
import type { GameRoad } from "./game-content-index";

/** 一次路径查询的输入；withCargo 为真时每经过一条道路额外加 1 tick。 */
export interface RouteQuery {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly factionId: string;
  readonly atTick: number;
  readonly withCargo: boolean;
}

/** 一次可用路径的结果；道路按经过顺序排列。 */
export interface RouteResult {
  readonly roadIds: readonly string[];
  readonly travelTicks: number;
}

/** 地图查询端口；所有读写都绑定到同一世界事务。 */
export interface GameMapPort {
  road(roadId: string): GameRoad | null;
  roadStatus(roadId: string): RoadStatus | null;
  findRoute(query: RouteQuery): RouteResult | null;
  hasPassage(roadId: string, factionId: string, atTick: number): boolean;
  setRoadStatus(
    roadId: string,
    status: RoadStatus,
    byId: string,
    force?: boolean,
  ): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  grantPassage(input: {
    readonly roadId: string;
    readonly granteeFactionId: string;
    readonly untilTick: number;
    readonly byId: string;
  }): { readonly ok: true; readonly grantId: string } | { readonly ok: false; readonly reasonCode: ReasonCode };
}
