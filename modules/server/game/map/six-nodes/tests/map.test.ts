/**
 * 验证六节点地图的平局排序与道路可用性，不依赖内容包或数据库。
 * 依赖内存 WorldTx、最小内容视图与地图端口。
 * 禁止用测试夹具替代真实内容包的路径数值。
 */
import { describe, expect, it } from "vitest";
import type { Json } from "@ai-npc/contracts";
import type { GameContent, GameRoad, WorldTx } from "@ai-npc/module-sdk";
import { createMapPort } from "../src/port";

function memoryTx(): WorldTx {
  const cells = new Map<string, Map<string, Json>>();
  let seq = 0;
  return {
    worldTick: 0,
    get<TState>(aggregateType: string, aggregateId: string) {
      const state = cells.get(aggregateType)?.get(aggregateId);
      return state === undefined ? null : { version: 1, state: state as TState };
    },
    list<TState>(aggregateType: string) {
      return [...(cells.get(aggregateType) ?? new Map<string, Json>()).entries()].map(
        ([id, state]) => ({ id, version: 1, state: state as TState }),
      );
    },
    put(aggregateType: string, aggregateId: string, state: Json) {
      const bucket = cells.get(aggregateType) ?? new Map<string, Json>();
      bucket.set(aggregateId, state);
      cells.set(aggregateType, bucket);
    },
    remove(aggregateType: string, aggregateId: string) {
      cells.get(aggregateType)?.delete(aggregateId);
    },
    emit() {
      seq += 1;
      return `evt-${String(seq).padStart(12, "0")}`;
    },
    schedule() {
      // 地图测试不创建 job。
    },
    cancelJobs() {
      // 地图测试不取消 job。
    },
  };
}

function content(roads: GameContent["roads"]): GameContent {
  return {
    nodes: new Map([
      ["a", { nodeId: "a", name: "A", x: 0, y: 0, facilities: [] }],
      ["b", { nodeId: "b", name: "B", x: 1, y: 0, facilities: [] }],
      ["c", { nodeId: "c", name: "C", x: 0, y: 1, facilities: [] }],
      ["d", { nodeId: "d", name: "D", x: 1, y: 1, facilities: [] }],
    ]),
    roads,
    factions: new Map(),
    characters: new Map(),
    stockpiles: new Map(),
    teams: new Map(),
    groups: new Map(),
    evidence: new Map(),
    starts: new Map(),
    migrationRoads: [],
    medicalFacilities: [],
    playerNodeId: "a",
    playerPrincipalId: "player-1",
    chapterId: "test",
    initialMeters: {
      "relay.stability": 0,
      "orchard.water": 0,
      "migration.safety": 0,
      "watergate.allocation": "harbor-first",
    },
    dutyDelegations: [],
  };
}

function road(id: string, from: string, to: string, ticks: number): GameRoad {
  return { roadId: id, a: from, b: to, travelTicks: ticks, risk: 0 };
}

describe("地图平局规则", () => {
  it("同行程同道路数时选择道路 ID 序列字典序更小者", () => {
    const roads = new Map([
      ["r-a-b", road("r-a-b", "a", "b", 2)],
      ["r-b-d", road("r-b-d", "b", "d", 2)],
      ["r-a-c", road("r-a-c", "a", "c", 2)],
      ["r-c-d", road("r-c-d", "c", "d", 2)],
    ]);
    const map = createMapPort(() => memoryTx(), content(roads), (prefix) => `${prefix}-000000000001`);
    expect(map.findRoute({ fromNodeId: "a", toNodeId: "d", factionId: "f", atTick: 0, withCargo: false })).toEqual({
      roadIds: ["r-a-b", "r-b-d"],
      travelTicks: 4,
    });
  });

  it("同行程时优先选择道路数更少者", () => {
    const roads = new Map([
      ["r-a-d", road("r-a-d", "a", "d", 4)],
      ["r-a-b", road("r-a-b", "a", "b", 2)],
      ["r-b-d", road("r-b-d", "b", "d", 2)],
    ]);
    const map = createMapPort(() => memoryTx(), content(roads), (prefix) => `${prefix}-000000000002`);
    expect(map.findRoute({ fromNodeId: "a", toNodeId: "d", factionId: "f", atTick: 0, withCargo: false })).toEqual({
      roadIds: ["r-a-d"],
      travelTicks: 4,
    });
  });
});
