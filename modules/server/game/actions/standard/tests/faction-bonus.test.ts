/**
 * 验证任务随队加成与修复判定完全由内容规则参数驱动。
 * 依赖合成的内容视图与规则参数夹具；不读写世界状态，也不加载真实内容包。
 * 禁止在本文件写死岗位主体或数值断言与夹具脱钩的耦合值。
 */
import { describe, expect, it } from "vitest";
import type { GameContent } from "@ai-npc/module-sdk";
import {
  escortSafetyBonus,
  isEnergyOnlyRepairTeam,
  repairBaseStability,
  rescueDurationDiscount,
  scoutTravelDiscountPerRoad,
  teamTransportCapacity,
  transportCapacityBonus,
  universalRepairStabilityBonus,
} from "../src/faction-bonus";

/** 角色档案：本派支持者与本队伍派系一致，通用主体与角色档案派系无关。 */
function contentWith(options: {
  readonly capacityAgentId?: string;
  readonly capacityBonus?: number;
  readonly rescueAgentId?: string;
  readonly rescueDiscount?: number;
  readonly scoutAgentId?: string;
  readonly scoutDiscount?: number;
  readonly guideAgentId?: string;
  readonly guideDiscount?: number;
  readonly escortAgentId?: string;
  readonly escortBonus?: number;
  readonly repairerAgentId?: string;
  readonly repairerBonus?: number;
  readonly repairerExcludedTeamIds?: readonly string[];
  readonly energyOnlyTeamIds?: readonly string[];
  readonly baseStability?: { readonly standard: number; readonly energyOnly: number };
}): GameContent {
  const characters = new Map<string, { readonly factionId: string }>();
  for (const agentId of [
    options.capacityAgentId ?? "cap",
    options.rescueAgentId ?? "rescue",
    options.scoutAgentId ?? "scout",
    options.guideAgentId ?? "guide",
    options.escortAgentId ?? "escort",
    options.repairerAgentId ?? "repairer",
  ]) {
    characters.set(agentId, { factionId: "faction-a" });
  }
  return {
    characters,
    rules: {
      tasks: {
        capacitySupporter: {
          agentId: options.capacityAgentId ?? "cap",
          capacityBonus: options.capacityBonus ?? 5,
        },
        repairSupporter: { agentId: "repair-supporter", stabilityBonus: 10 },
        rescueSupporter: {
          agentId: options.rescueAgentId ?? "rescue",
          durationDiscountTicks: options.rescueDiscount ?? 2,
        },
        scoutSupporter: {
          agentId: options.scoutAgentId ?? "scout",
          travelDiscountPerRoad: options.scoutDiscount ?? 1,
        },
        escortSupporter: {
          agentId: options.escortAgentId ?? "escort",
          safetyBonus: options.escortBonus ?? 4,
        },
        universalGuide: {
          agentId: options.guideAgentId ?? "guide",
          travelDiscountPerRoad: options.guideDiscount ?? 1,
        },
        universalRepairer: {
          agentId: options.repairerAgentId ?? "repairer",
          stabilityBonus: options.repairerBonus ?? 15,
          excludedTeamIds: options.repairerExcludedTeamIds ?? [],
        },
        repairWorkNodeId: "work-node",
        energyOnlyRepairTeamIds: options.energyOnlyTeamIds ?? [],
        repairBaseStability: options.baseStability ?? { standard: 25, energyOnly: 40 },
      },
      settlement: {
        dailySupplyStockpileId: "sp-a",
        dailySupplyAmount: 6,
        orchardMedicalStockpileId: "sp-b",
        orchardMedicalAmount: 5,
        migrationRoadId: "r-a",
        migrationPassageFactionId: "faction-b",
      },
      watergateSeatId: "seat.test",
    },
  } as unknown as GameContent;
}

describe("任务随队加成由内容规则驱动", () => {
  it("运输运力加成取内容数值，且只认本派角色", () => {
    const content = contentWith({ capacityBonus: 7 });
    expect(transportCapacityBonus(content, "faction-a", ["cap"])).toBe(7);
    // 支持者角色档案属于 faction-a：跨派队伍不获得加成。
    expect(transportCapacityBonus(content, "faction-b", ["cap"])).toBe(0);
    expect(teamTransportCapacity(content, "faction-a", 20, ["cap"])).toBe(27);
    expect(teamTransportCapacity(content, "faction-a", 20, [])).toBe(20);
  });

  it("修复基础值由 energyOnlyRepairTeamIds 与 repairBaseStability 驱动", () => {
    const content = contentWith({
      energyOnlyTeamIds: ["team-e"],
      baseStability: { standard: 21, energyOnly: 33 },
    });
    expect(isEnergyOnlyRepairTeam(content, "team-e")).toBe(true);
    expect(repairBaseStability(content, "team-e")).toBe(33);
    expect(repairBaseStability(content, "team-x")).toBe(21);
  });

  it("通用修复者加成按 excludedTeamIds 豁免，与仅能源名单互不影响", () => {
    // 豁免名单与仅能源名单是两个独立旋钮：仅能源但未豁免的队伍仍获得加成。
    const content = contentWith({
      repairerExcludedTeamIds: ["team-excluded"],
      energyOnlyTeamIds: ["team-energy-only"],
    });
    expect(universalRepairStabilityBonus(content, ["repairer"], "team-normal")).toBe(15);
    expect(universalRepairStabilityBonus(content, ["repairer"], "team-excluded")).toBe(0);
    expect(universalRepairStabilityBonus(content, ["repairer"], "team-energy-only")).toBe(15);
    expect(universalRepairStabilityBonus(content, [], "team-normal")).toBe(0);
  });

  it("救援用时折扣取内容数值，且只认本派角色", () => {
    const content = contentWith({ rescueDiscount: 3 });
    expect(rescueDurationDiscount(content, "faction-a", ["rescue"])).toBe(3);
    expect(rescueDurationDiscount(content, "faction-b", ["rescue"])).toBe(0);
  });

  it("侦察逐路折扣本派支持者优先，通用向导按自己的数值生效", () => {
    const content = contentWith({ scoutDiscount: 2, guideDiscount: 1 });
    expect(scoutTravelDiscountPerRoad(content, "faction-a", ["scout"])).toBe(2);
    // 通用向导对任何队伍同效，不受派系限制。
    expect(scoutTravelDiscountPerRoad(content, "faction-b", ["guide"])).toBe(1);
    expect(scoutTravelDiscountPerRoad(content, "faction-a", ["scout", "guide"])).toBe(2);
    expect(scoutTravelDiscountPerRoad(content, "faction-a", [])).toBe(0);
  });

  it("护送安全加成取内容数值，本派支持者与通用向导同效", () => {
    const content = contentWith({ escortBonus: 6 });
    expect(escortSafetyBonus(content, "faction-a", ["escort"])).toBe(6);
    expect(escortSafetyBonus(content, "faction-b", ["guide"])).toBe(6);
    expect(escortSafetyBonus(content, "faction-b", ["escort"])).toBe(0);
  });
});
