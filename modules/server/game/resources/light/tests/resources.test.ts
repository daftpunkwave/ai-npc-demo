/**
 * 验证资源模块的预留、释放、消耗、转移与等级计算在单事务内保持一致。
 * 依赖最小内容视图、内存 WorldTx 与资源端口；不启动网络或 authority。
 * 禁止用固定写死的库存替代模块初始化路径。
 */
import { describe, expect, it } from "vitest";
import type { Json } from "@ai-npc/contracts";
import type { GameContent, WorldTx } from "@ai-npc/module-sdk";
import { createResourcesPort } from "../src/port";

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
      // 资源模块不创建 job。
    },
    cancelJobs() {
      // 资源模块不取消 job。
    },
  };
}

function content(): GameContent {
  return {
    nodes: new Map([
      ["grayharbor", { nodeId: "grayharbor", name: "灰港中继站", x: 12, y: 12, facilities: ["relay"] }],
      ["orchard", { nodeId: "orchard", name: "灼痕果园", x: 19, y: 9, facilities: ["clinic"] }],
    ]),
    roads: new Map(),
    factions: new Map(),
    characters: new Map(),
    stockpiles: new Map([
      [
        "sp-commons",
        {
          stockpileId: "sp-commons",
          nodeId: "grayharbor",
          ownerFactionId: "human-neutral",
          supply: 60,
          energy: 12,
          medical: 8,
        },
      ],
      [
        "sp-earth",
        {
          stockpileId: "sp-earth",
          nodeId: "orchard",
          ownerFactionId: "human-earth-alliance",
          supply: 20,
          energy: 4,
          medical: 12,
        },
      ],
    ]),
    teams: new Map(),
    groups: new Map(),
    evidence: new Map(),
    starts: new Map(),
    migrationRoads: [],
    medicalFacilities: [],
    playerNodeId: "grayharbor",
    playerPrincipalId: "player-1",
    chapterId: "watergate",
    initialMeters: {
      "relay.stability": 45,
      "orchard.water": 50,
      "migration.safety": 50,
      "watergate.allocation": "harbor-first",
    },
    dutyDelegations: [],
  };
}

describe("轻资源", () => {
  const gameContent = content();

  function port(): ReturnType<typeof createResourcesPort> {
    const tx = memoryTx();
    const result = createResourcesPort(() => tx, gameContent, { scarceRatio: 0.3, surplusRatio: 1.2 });
    result.initializeCampaign(gameContent);
    return result;
  }

  it("预留、拒绝超量、释放与转移", () => {
    const resources = port();
    expect(resources.available("sp-commons", "supply")).toBe(60);
    expect(resources.reserve({ stockpileId: "sp-commons", delta: { supply: 40, energy: 0, medical: 0 }, taskId: "task-000000000001", byId: "player-1" })).toMatchObject({ ok: true });
    expect(resources.reserve({ stockpileId: "sp-commons", delta: { supply: 30, energy: 0, medical: 0 }, taskId: "task-000000000002", byId: "player-1" })).toMatchObject({ ok: false, reasonCode: "insufficient-resource" });
    expect(resources.available("sp-commons", "supply")).toBe(20);
    expect(resources.release({ stockpileId: "sp-commons", delta: { supply: 10, energy: 0, medical: 0 }, taskId: "task-000000000001", byId: "player-1" })).toMatchObject({ ok: true });
    expect(resources.available("sp-commons", "supply")).toBe(30);
    expect(resources.transfer({
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-earth",
      delta: { supply: 20, energy: 0, medical: 0 },
      taskId: "task-000000000003",
      byId: "player-1",
    })).toMatchObject({ ok: true });
    expect(resources.available("sp-commons", "supply")).toBe(30);
    expect(resources.stockpile("sp-earth")).toMatchObject({ amount: { supply: 40 } });
  });

  it("非预留消耗不挤占任务预留，调整不能低于预留", () => {
    const resources = port();
    expect(resources.reserve({ stockpileId: "sp-commons", delta: { supply: 10, energy: 0, medical: 0 }, taskId: "task-000000000004", byId: "player-1" })).toMatchObject({ ok: true });
    expect(resources.consume({
      stockpileId: "sp-commons",
      delta: { supply: 6, energy: 0, medical: 0 },
      reason: "daily",
      taskId: "task-000000000005",
      byId: "player-1",
      fromReservation: false,
    })).toMatchObject({ ok: true });
    expect(resources.stockpile("sp-commons")).toMatchObject({ amount: { supply: 54 }, reserved: { supply: 10 } });
    expect(resources.adjust({ stockpileId: "sp-commons", delta: { supply: -50 }, reason: "test" })).toMatchObject({ ok: false, reasonCode: "insufficient-resource" });
  });

  it("按基线计算展示等级", () => {
    const resources = port();
    expect(resources.level("sp-commons")).toEqual({
      supply: "adequate",
      energy: "adequate",
      medical: "adequate",
    });
    resources.adjust({ stockpileId: "sp-commons", delta: { supply: -50 }, reason: "test" });
    expect(resources.level("sp-commons").supply).toBe("scarce");
  });
});
