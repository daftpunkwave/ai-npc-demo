/**
 * 验证每日结算的库存目标、数量与迁徙道路判定完全由内容规则参数驱动。
 * 依赖世界模块状态 schema、确定性内存事务与端口桩；不访问真实存储或真实内容包。
 * 禁止在本文件写死内容 ID 断言与夹具脱钩的耦合值。
 */
import { describe, expect, it } from "vitest";
import type { Json } from "@ai-npc/contracts";
import type { GameContent, GameModulePorts, WorldTx } from "@ai-npc/module-sdk";
import { runDailySettlement } from "../src/settlement";
import { campaignAggregateId, metersAggregateId } from "../src/port";
import { createTestHost, TestWorldTx } from "./support";

/** 记录领域事件的事件事务；供结算事件断言使用。 */
class RecordingTx extends TestWorldTx {
  private readonly recorded: { type: string; payload: Json }[] = [];

  override emit(type: string, payload: Json): string {
    this.recorded.push({ type, payload });
    return super.emit(type, payload, []);
  }

  /** 已记录的领域事件，供测试断言结算发布的事件类型。 */
  events(): readonly { readonly type: string; readonly payload: Json }[] {
    return this.recorded;
  }
}

interface SettlementRulesOverride {
  readonly dailySupplyStockpileId?: string;
  readonly dailySupplyAmount?: number;
  readonly orchardMedicalStockpileId?: string;
  readonly orchardMedicalAmount?: number;
  readonly migrationRoadId?: string;
  readonly migrationPassageFactionId?: string;
}

/** 构造通过 requireGameContent 结构断言的最小内容视图；规则参数可逐项覆写。 */
function contentWith(settlement: SettlementRulesOverride): GameContent {
  const emptyMap = new Map();
  return {
    nodes: emptyMap,
    roads: emptyMap,
    factions: emptyMap,
    characters: emptyMap,
    stockpiles: new Map([
      ["sp-supply", { stockpileId: "sp-supply" }],
      ["sp-medical", { stockpileId: "sp-medical" }],
    ]),
    teams: emptyMap,
    groups: emptyMap,
    evidence: emptyMap,
    starts: emptyMap,
    scenarios: emptyMap,
    defaultScenario: "test",
    rules: {
      tasks: {
        capacitySupporter: { agentId: "cap", capacityBonus: 5 },
        repairSupporter: { agentId: "repair", stabilityBonus: 10 },
        rescueSupporter: { agentId: "rescue", durationDiscountTicks: 2 },
        scoutSupporter: { agentId: "scout", travelDiscountPerRoad: 1 },
        escortSupporter: { agentId: "escort", safetyBonus: 4 },
        universalGuide: { agentId: "guide", travelDiscountPerRoad: 1 },
        universalRepairer: { agentId: "repairer", stabilityBonus: 15, excludedTeamIds: [] },
        repairWorkNodeId: "work-node",
        energyOnlyRepairTeamIds: [],
        repairBaseStability: { standard: 25, energyOnly: 40 },
      },
      settlement: {
        dailySupplyStockpileId: settlement.dailySupplyStockpileId ?? "sp-supply",
        dailySupplyAmount: settlement.dailySupplyAmount ?? 6,
        orchardMedicalStockpileId: settlement.orchardMedicalStockpileId ?? "sp-medical",
        orchardMedicalAmount: settlement.orchardMedicalAmount ?? 5,
        migrationRoadId: settlement.migrationRoadId ?? "r-migration",
        migrationPassageFactionId: settlement.migrationPassageFactionId ?? "faction-pass",
      },
      watergateSeatId: "seat.test",
    },
    notificationTexts: { invite: "i", deadline: "d", failedTask: "f", crisis: "c" },
    migrationRoads: [],
    medicalFacilities: [],
    playerNodeId: "node-a",
    playerPrincipalId: "player-1",
    chapterId: "test",
    initialMeters: {
      "relay.stability": 45,
      "orchard.water": 50,
      "migration.safety": 50,
      "watergate.allocation": "harbor-first",
    },
    dutyDelegations: [],
  } as unknown as GameContent;
}

interface ResourceCall {
  readonly kind: "consume" | "adjust";
  readonly stockpileId: string;
  readonly delta: Json;
}

interface PortStubs {
  readonly modules: GameModulePorts;
  readonly calls: readonly ResourceCall[];
}

/** 构造只覆盖结算读取路径的资源与地图端口桩；其余端点直接失败以防误用。 */
function portStubs(options: {
  readonly supplyAvailable: number;
  readonly medicalAvailable: number;
  readonly roadStatus: "open" | "restricted" | "closed";
  readonly hasPassage: boolean;
}): PortStubs {
  const calls: ResourceCall[] = [];
  const modules = {
    "game.map": {
      roadStatus: () => options.roadStatus,
      hasPassage: () => options.hasPassage,
    },
    "game.resources": {
      stockpile: (stockpileId: string) => ({
        stockpileId,
        nodeId: "node-a",
        ownerFactionId: "faction-a",
        amount:
          stockpileId === "sp-supply"
            ? { supply: options.supplyAvailable, energy: 0, medical: 0 }
            : { supply: 0, energy: 0, medical: options.medicalAvailable },
        reserved: { supply: 0, energy: 0, medical: 0 },
        baseline: { supply: 100, energy: 100, medical: 100 },
      }),
      consume: (input: { stockpileId: string; delta: Json }) => {
        calls.push({ kind: "consume", stockpileId: input.stockpileId, delta: input.delta });
        return { ok: true };
      },
      adjust: (input: { stockpileId: string; delta: Json }) => {
        calls.push({ kind: "adjust", stockpileId: input.stockpileId, delta: input.delta });
        return { ok: true };
      },
    },
  } as unknown as GameModulePorts;
  return { modules, calls };
}

/** 在事务内种下 t0 开局的 campaign 与指标聚合，返回结算调用所需的处理器上下文。 */
function seedAndRun(options: {
  readonly tx: RecordingTx;
  readonly modules: GameModulePorts;
  readonly content: GameContent;
  readonly tick: number;
}): void {
  const { tx } = options;
  tx.put("campaign", campaignAggregateId, {
    campaignId: "cmp-1",
    factionId: "faction-a",
    playerId: "player-1",
    chapterId: "test",
    startTick: 0,
    status: "running",
    outcome: null,
  });
  tx.put("meters", metersAggregateId, {
    "relay.stability": 45,
    "orchard.water": 5,
    "migration.safety": 50,
    "watergate.allocation": "harbor-first",
    triggered: [],
    lastDailyTick: null,
  });
  runDailySettlement(
    {
      auth: {} as never,
      tx,
      modules: options.modules,
      approvedSpeech: {} as never,
      content: options.content,
      rng: () => () => 0.5,
      ids: createTestHost().ids,
    },
    options.tick,
  );
}

function metersOf(tx: WorldTx): Record<string, number> {
  const record = tx.get<Record<string, number>>("meters", metersAggregateId);
  if (record === null) {
    throw new Error("结算没有写入指标聚合");
  }
  return record.state;
}

describe("每日结算由内容规则参数驱动", () => {
  it("供给扣减的目标库存与数量来自规则参数", () => {
    const content = contentWith({ dailySupplyStockpileId: "sp-supply", dailySupplyAmount: 6 });
    const { modules, calls } = portStubs({
      supplyAvailable: 100,
      medicalAvailable: 0,
      roadStatus: "open",
      hasPassage: false,
    });
    const tx = new RecordingTx(24);
    seedAndRun({ tx, modules, content, tick: 24 });
    const consume = calls.filter((call) => call.kind === "consume");
    expect(consume).toHaveLength(1);
    expect(consume[0]?.stockpileId).toBe("sp-supply");
    expect(consume[0]?.delta).toEqual({ supply: 6, energy: 0, medical: 0 });
  });

  it("可用量低于规则目标时按可用量扣减并发布短缺事件", () => {
    const content = contentWith({ dailySupplyStockpileId: "sp-supply", dailySupplyAmount: 6 });
    const { modules, calls } = portStubs({
      supplyAvailable: 2,
      medicalAvailable: 0,
      roadStatus: "open",
      hasPassage: false,
    });
    const tx = new RecordingTx(24);
    seedAndRun({ tx, modules, content, tick: 24 });
    const consume = calls.filter((call) => call.kind === "consume");
    expect(consume[0]?.delta).toEqual({ supply: 2, energy: 0, medical: 0 });
    expect(tx.events().some((event) => event.type === "SupplyShortage")).toBe(true);
  });

  it("迁徙安全按规则声明的道路状态与通行许可判定", () => {
    const content = contentWith({ migrationRoadId: "r-migration", migrationPassageFactionId: "faction-pass" });
    const closed = portStubs({
      supplyAvailable: 100,
      medicalAvailable: 0,
      roadStatus: "closed",
      hasPassage: false,
    });
    const closedTx = new RecordingTx(96);
    seedAndRun({ tx: closedTx, modules: closed.modules, content, tick: 96 });
    expect(metersOf(closedTx)["migration.safety"]).toBe(40);

    const restrictedNoPassage = portStubs({
      supplyAvailable: 100,
      medicalAvailable: 0,
      roadStatus: "restricted",
      hasPassage: false,
    });
    const restrictedTx = new RecordingTx(96);
    seedAndRun({ tx: restrictedTx, modules: restrictedNoPassage.modules, content, tick: 96 });
    expect(metersOf(restrictedTx)["migration.safety"]).toBe(44);

    const restrictedWithPassage = portStubs({
      supplyAvailable: 100,
      medicalAvailable: 0,
      roadStatus: "restricted",
      hasPassage: true,
    });
    const passageTx = new RecordingTx(96);
    seedAndRun({ tx: passageTx, modules: restrictedWithPassage.modules, content, tick: 96 });
    expect(metersOf(passageTx)["migration.safety"]).toBe(48);
  });

  it("果园损坏的医疗扣减目标与数量来自规则参数", () => {
    const content = contentWith({ orchardMedicalStockpileId: "sp-medical", orchardMedicalAmount: 4 });
    const { modules, calls } = portStubs({
      supplyAvailable: 100,
      medicalAvailable: 10,
      roadStatus: "open",
      hasPassage: false,
    });
    const tx = new RecordingTx(24);
    seedAndRun({ tx, modules, content, tick: 24 });
    const adjust = calls.filter((call) => call.kind === "adjust");
    expect(adjust).toHaveLength(1);
    expect(adjust[0]?.stockpileId).toBe("sp-medical");
    expect(adjust[0]?.delta).toEqual({ medical: -4 });
    expect(metersOf(tx)["orchard.water"]).toBe(0);
  });
});
