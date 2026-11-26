/**
 * 验证六节点地图的平局排序与道路可用性，不依赖数据库。
 * 依赖真实内容包、最小 WorldTx 与地图端口。
 * 禁止用测试夹具替代真实内容包的路径数值。
 */
import { describe, expect, it } from "vitest";
import { loadContentPack } from "@world-prism/experiment";
import type { GameContent, GameRoad } from "@world-prism/module-sdk";
import { createMapPort } from "@world-prism/mod-game-map-six-nodes";
import { createMemoryTx, toGameContent } from "./game-support";

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
    secrets: new Map(),
    starts: new Map(),
    scenarios: new Map(),
    defaultScenario: "test",
    rules: {
      tasks: {
        capacitySupporter: { agentId: "supporter", capacityBonus: 5 },
        repairSupporter: { agentId: "supporter", stabilityBonus: 10 },
        rescueSupporter: { agentId: "supporter", durationDiscountTicks: 2 },
        scoutSupporter: { agentId: "supporter", travelDiscountPerRoad: 1 },
        escortSupporter: { agentId: "supporter", safetyBonus: 4 },
        universalGuide: { agentId: "guide", travelDiscountPerRoad: 1 },
        universalRepairer: { agentId: "repairer", stabilityBonus: 15, excludedTeamIds: [] },
        repairWorkNodeId: "a",
        energyOnlyRepairTeamIds: [],
        repairBaseStability: { standard: 25, energyOnly: 40 },
      },
      settlement: {
        dailySupplyStockpileId: "sp-test",
        dailySupplyAmount: 6,
        orchardMedicalStockpileId: "sp-test",
        orchardMedicalAmount: 5,
        migrationRoadId: "r-a-b",
        migrationPassageFactionId: "f",
      },
      watergateSeatId: "seat.test",
    },
    notificationTexts: {
      invite: "收到新的协议提案",
      deadline: "协议条款将在 {window} tick 内到期",
      failedTask: "委托的任务已失败",
      crisis: "局势指标处于危急",
    },
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
    cityResources: { energy: 0, materials: 0, food: 0, supply: 0, medical: 0, water: 0 },
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
    const map = createMapPort(() => createMemoryTx(), content(roads), (prefix) => `${prefix}-000000000001`);
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
    const map = createMapPort(() => createMemoryTx(), content(roads), (prefix) => `${prefix}-000000000002`);
    expect(map.findRoute({ fromNodeId: "a", toNodeId: "d", factionId: "f", atTick: 0, withCargo: false })).toEqual({
      roadIds: ["r-a-d"],
      travelTicks: 4,
    });
  });
});

describe("内容包地图", () => {
  const pack = loadContentPack("content", "earth-2964-v1");
  const gameContent = toGameContent(pack);

  it("按行程与货物加成求最短路", () => {
    const tx = createMemoryTx();
    const map = createMapPort(() => tx, gameContent, (prefix) => `${prefix}-000000000003`);
    expect(map.findRoute({ fromNodeId: "grayharbor", toNodeId: "orchard", factionId: "human-neutral", atTick: 0, withCargo: false })).toEqual({
      roadIds: ["r-gh-or"],
      travelTicks: 5,
    });
    expect(map.findRoute({ fromNodeId: "grayharbor", toNodeId: "orchard", factionId: "human-neutral", atTick: 0, withCargo: true })).toEqual({
      roadIds: ["r-gh-or"],
      travelTicks: 6,
    });
  });

  it("受控道路在无通行许可时不可达，授予后可通行", () => {
    const tx = createMemoryTx();
    const map = createMapPort(() => tx, gameContent, (prefix) => `${prefix}-000000000004`);
    expect(map.findRoute({ fromNodeId: "anchor", toNodeId: "grayharbor", factionId: "human-alien-accord", atTick: 0, withCargo: false })).toBeNull();
    expect(map.grantPassage({
      roadId: "r-gh-an",
      granteeFactionId: "human-alien-accord",
      untilTick: 100,
      byId: "species-extraterrestrial",
    })).toMatchObject({ ok: true });
    expect(map.findRoute({ fromNodeId: "anchor", toNodeId: "grayharbor", factionId: "human-alien-accord", atTick: 0, withCargo: false })).toEqual({
      roadIds: ["r-gh-an"],
      travelTicks: 5,
    });
  });

  it("控制方可以关闭道路，非控制方被拒绝", () => {
    const tx = createMemoryTx();
    const map = createMapPort(() => tx, gameContent, (prefix) => `${prefix}-000000000005`);
    expect(map.setRoadStatus("r-gh-ps", "closed", "human-neutral")).toMatchObject({ ok: false, reasonCode: "no-authority" });
    expect(map.setRoadStatus("r-gh-ps", "closed", "human-independent")).toMatchObject({ ok: true });
    expect(map.findRoute({ fromNodeId: "grayharbor", toNodeId: "pass", factionId: "human-neutral", atTick: 0, withCargo: false })).toEqual({
      roadIds: ["r-gh-ar", "r-ps-ar"],
      travelTicks: 9,
    });
  });
});
