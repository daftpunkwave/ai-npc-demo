/**
 * 验证资源模块的预留、按任务释放/转移、非预留消耗、等级计算与全部库存点的批量查询。
 * 依赖真实内容包、内存 WorldTx 与资源端口。
 * 禁止把资源 ID 当作无校验对象索引。
 */
import { describe, expect, it } from "vitest";
import { DomainError, type Json } from "@world-prism/contracts";
import { loadContentPack } from "@world-prism/experiment";
import { createResourcesPort } from "@world-prism/mod-game-resources-light";
import type { GameResourcesPort, StockpileStatus, WorldTx } from "@world-prism/module-sdk";
import { createMemoryTx, toGameContent } from "./game-support";

const content = toGameContent(loadContentPack("content", "earth-2964-v1"));
const thresholds = { scarceRatio: 0.3, surplusRatio: 1.2 };

function port(): ReturnType<typeof createResourcesPort> {
  const tx = createMemoryTx();
  const result = createResourcesPort(() => tx, thresholds);
  result.initializeCampaign(content);
  return result;
}

function statusOf(resources: GameResourcesPort, stockpileId: string): StockpileStatus | undefined {
  return resources.stockpiles().find((entry) => entry.stockpileId === stockpileId);
}

/** 记录每次聚合读取的 WorldTx 包装，用来断言批量查询的读取次数。 */
function countingTx(inner: WorldTx): { readonly tx: WorldTx; readonly reads: string[] } {
  const reads: string[] = [];
  const tx: WorldTx = {
    ...inner,
    get: (aggregateType, aggregateId) => {
      reads.push(`get:${aggregateType}:${aggregateId}`);
      return inner.get(aggregateType, aggregateId);
    },
    list: (aggregateType, options) => {
      reads.push(`list:${aggregateType}`);
      return inner.list(aggregateType, options);
    },
  };
  return { tx, reads };
}

describe("轻资源", () => {
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
      taskId: "task-000000000001",
      byId: "player-1",
    })).toMatchObject({ ok: true });
    expect(resources.transfer({
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-commons",
      delta: { supply: 1, energy: 0, medical: 0 },
      taskId: "task-000000000001",
      byId: "player-1",
    })).toMatchObject({ ok: false, reasonCode: "invalid-params" });
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
      taskId: null,
      byId: "player-1",
      fromReservation: false,
    })).toMatchObject({ ok: true });
    expect(resources.stockpile("sp-commons")).toMatchObject({ amount: { supply: 54 }, reserved: { supply: 10 } });
    expect(resources.adjust({ stockpileId: "sp-commons", delta: { supply: -50 }, reason: "test" })).toMatchObject({ ok: false, reasonCode: "insufficient-resource" });
  });

  it("非 clamp 调整按可用量整笔校验，越界时拒绝且不改库存", () => {
    const resources = port();
    expect(resources.consume({
      stockpileId: "sp-commons",
      delta: { supply: 55, energy: 0, medical: 0 },
      reason: "fixture",
      taskId: null,
      byId: "player-1",
      fromReservation: false,
    })).toMatchObject({ ok: true });
    expect(resources.available("sp-commons", "supply")).toBe(5);

    // 库存 5、reserved 0、申请 -100：整笔失败，不能静默扣到 0。
    expect(resources.adjust({ stockpileId: "sp-commons", delta: { supply: -100 }, reason: "test" })).toMatchObject({
      ok: false,
      reasonCode: "insufficient-resource",
    });
    expect(resources.stockpile("sp-commons")).toMatchObject({ amount: { supply: 5 }, reserved: { supply: 0 } });

    // 多资源中能源不足：供给不得被部分扣减。
    expect(
      resources.adjust({ stockpileId: "sp-commons", delta: { supply: -1, energy: -13 }, reason: "test" }),
    ).toMatchObject({ ok: false, reasonCode: "insufficient-resource" });
    expect(resources.stockpile("sp-commons")).toMatchObject({ amount: { supply: 5, energy: 12 } });

    // 可用量以内的调整照常精确扣减。
    expect(resources.adjust({ stockpileId: "sp-commons", delta: { supply: -5 }, reason: "test" })).toMatchObject({
      ok: true,
    });
    expect(resources.stockpile("sp-commons")).toMatchObject({ amount: { supply: 0 } });
  });

  it("按基线计算展示等级", () => {
    const resources = port();
    expect(statusOf(resources, "sp-commons")?.levels).toEqual({
      supply: "adequate",
      energy: "adequate",
      medical: "adequate",
    });
    resources.adjust({ stockpileId: "sp-commons", delta: { supply: -50 }, reason: "test" });
    expect(statusOf(resources, "sp-commons")?.levels.supply).toBe("scarce");
  });

  it("批量查询按 ID 升序返回全部库存点的快照与等级，快照与单点查询一致", () => {
    const resources = port();
    resources.adjust({ stockpileId: "sp-commons", delta: { supply: -50 }, reason: "test" });
    const statuses = resources.stockpiles();
    const expectedIds = [...content.stockpiles.keys()].sort();
    expect(statuses.map((entry) => entry.stockpileId)).toEqual(expectedIds);
    for (const status of statuses) {
      const { levels, ...snapshot } = status;
      expect(snapshot).toEqual(resources.stockpile(status.stockpileId));
      expect(Object.keys(levels).sort()).toEqual(["energy", "medical", "supply"]);
    }
    expect(statusOf(resources, "sp-commons")).toMatchObject({
      nodeId: "grayharbor",
      ownerFactionId: "human-neutral",
      amount: { supply: 10, energy: 12, medical: 8 },
      baseline: { supply: 60, energy: 12, medical: 8 },
      levels: { supply: "scarce", energy: "adequate", medical: "adequate" },
    });
  });

  it("开局初始化前批量查询为空集合，不按内容初值伪造库存", () => {
    const resources = createResourcesPort(() => createMemoryTx(), thresholds);
    expect(resources.stockpiles()).toEqual([]);
  });

  it("批量查询只列一次库存聚合，不按 ID 逐个回查", () => {
    const memory = createMemoryTx();
    createResourcesPort(() => memory, thresholds).initializeCampaign(content);
    const { tx, reads } = countingTx(memory);
    const statuses = createResourcesPort(() => tx, thresholds).stockpiles();
    expect(statuses).toHaveLength(content.stockpiles.size);
    expect(reads).toEqual(["list:stockpile"]);
  });

  it("库存状态不合法时批量查询按 invalid-state 拒绝并带出库存点", () => {
    const memory = createMemoryTx();
    const resources = createResourcesPort(() => memory, thresholds);
    resources.initializeCampaign(content);
    const broken = memory.get<Record<string, unknown>>("stockpile", "sp-earth")?.state;
    memory.put("stockpile", "sp-earth", { ...broken, reserved: { supply: 999, energy: 0, medical: 0 } });
    let caught: unknown;
    try {
      resources.stockpiles();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught).toMatchObject({ code: "invalid-state", details: { stockpileId: "sp-earth" } });
  });

  it("状态内的库存点 ID 与聚合 ID 不一致时，批量与单点查询都按 invalid-state 拒绝", () => {
    const memory = createMemoryTx();
    const resources = createResourcesPort(() => memory, thresholds);
    resources.initializeCampaign(content);
    // 把 sp-commons 的状态原样写到 sp-earth 名下，模拟聚合 ID 与状态内 ID 不一致的损坏数据。
    const commons = memory.get<Json>("stockpile", "sp-commons")?.state ?? null;
    memory.put("stockpile", "sp-earth", commons);
    const expected = { code: "invalid-state", details: { stockpileId: "sp-earth", stateStockpileId: "sp-commons" } };
    expect(() => resources.stockpiles()).toThrow(DomainError);
    expect(() => resources.stockpiles()).toThrow(expect.objectContaining(expected));
    expect(() => resources.stockpile("sp-earth")).toThrow(expect.objectContaining(expected));
  });
});
