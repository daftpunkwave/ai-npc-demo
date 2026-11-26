/**
 * 验证资源模块的预留、按任务释放/转移、非预留消耗与等级计算。
 * 依赖真实内容包、内存 WorldTx 与资源端口。
 * 禁止把资源 ID 当作无校验对象索引。
 */
import { describe, expect, it } from "vitest";
import { loadContentPack } from "@world-prism/experiment";
import { createResourcesPort } from "@world-prism/mod-game-resources-light";
import { createMemoryTx, toGameContent } from "./game-support";

const content = toGameContent(loadContentPack("content", "earth-2964-v1"));

function port(): ReturnType<typeof createResourcesPort> {
  const tx = createMemoryTx();
  const result = createResourcesPort(() => tx, { scarceRatio: 0.3, surplusRatio: 1.2 });
  result.initializeCampaign(content);
  return result;
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
    expect(resources.level("sp-commons")).toEqual({
      supply: "adequate",
      energy: "adequate",
      medical: "adequate",
    });
    resources.adjust({ stockpileId: "sp-commons", delta: { supply: -50 }, reason: "test" });
    expect(resources.level("sp-commons").supply).toBe("scarce");
  });
});
