/**
 * 验证剧情元数据驱动广播发布节点、压力卡标记与 signature-only 署名校验。
 * 依赖剧情模块的规则贡献、效果白名单与确定性内存事务；不加载真实内容包。
 * 禁止在本文件写死具体剧情卡或节点 ID 与夹具脱钩的耦合值。
 */
import { describe, expect, it } from "vitest";
import type { CardEffect, Json } from "@world-prism/contracts";
import type { GameContent, GameModulePorts, HandlerContext } from "@world-prism/module-sdk";
import { createScenarioContributor } from "../src/contributor";
import { invalidEffectReferences } from "../src/effects";

/** 取出剧情模块的卡片 job；缺失即夹具错误。 */
function requireCardJob(contributor: ReturnType<typeof createScenarioContributor>) {
  const job = contributor.jobs?.find((entry) => entry.kind === "scenario.card");
  if (job === undefined) {
    throw new Error("剧情模块没有注册卡片 job");
  }
  return job;
}

interface ScenarioMetaOverride {
  readonly broadcastOriginNodeId?: string;
  readonly pressureCardId?: string;
  readonly signatureOnlyPrincipalIds?: readonly string[];
}

/** 构造通过 requireGameContent 结构断言的最小内容视图；剧情元数据可逐项覆写。 */
function contentWith(meta: ScenarioMetaOverride): GameContent {
  const emptyMap = new Map();
  const scenario = {
    scenarioId: "test-scenario",
    broadcastOriginNodeId: meta.broadcastOriginNodeId ?? "origin-node",
    pressureCardId: meta.pressureCardId,
    signatureOnlyPrincipalIds: meta.signatureOnlyPrincipalIds ?? ["npc-signer"],
    cards: [
      {
        cardId: "card-alarm",
        version: 1,
        trigger: { atTick: 5 },
        effects: [
          { kind: "broadcast", speakerId: "npc-signer", text: "alarm" },
        ],
      },
      {
        cardId: "card-other",
        version: 1,
        trigger: { atTick: 9 },
        effects: [
          { kind: "broadcast", speakerId: "npc-signer", text: "other" },
        ],
      },
    ],
  };
  return {
    nodes: emptyMap,
    roads: emptyMap,
    factions: emptyMap,
    characters: emptyMap,
    stockpiles: emptyMap,
    teams: emptyMap,
    groups: emptyMap,
    evidence: emptyMap,
    starts: emptyMap,
    scenarios: new Map([["test-scenario", scenario]]),
    defaultScenario: "test-scenario",
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
        dailySupplyStockpileId: "sp-a",
        dailySupplyAmount: 6,
        orchardMedicalStockpileId: "sp-b",
        orchardMedicalAmount: 5,
        migrationRoadId: "r-a",
        migrationPassageFactionId: "faction-b",
      },
      watergateSeatId: "seat.test",
    },
    notificationTexts: { invite: "i", deadline: "d", failedTask: "f", crisis: "c" },
    migrationRoads: [],
    medicalFacilities: [],
    playerNodeId: "origin-node",
    playerPrincipalId: "player-1",
    chapterId: "test",
    initialMeters: {
      "relay.stability": 45,
      "orchard.water": 50,
      "migration.safety": 50,
      "watergate.allocation": "harbor-first",
    },
    dutyDelegations: [],
    cityResources: { energy: 140, materials: 160, food: 120, supply: 60, medical: 40, water: 72 },
  } as unknown as GameContent;
}

interface MemoryTx {
  put(aggregateType: string, aggregateId: string, state: Json): void;
  get(aggregateType: string, aggregateId: string): { readonly state: Json } | null;
  emit(type: string, payload: Json): string;
}

/** 构造记录聚合写入与事件的内存事务，供剧情卡触发测试使用。 */
function makeMemoryTx(): MemoryTx & {
  /** 已记录的领域事件，供压力卡与触发事件断言使用。 */
  events(): readonly { readonly type: string; readonly payload: Json }[];
} {
  const cells = new Map<string, Json>();
  const events: { type: string; payload: Json }[] = [];
  return {
    put(aggregateType: string, aggregateId: string, state: Json) {
      cells.set(`${aggregateType}:${aggregateId}`, state);
    },
    get(aggregateType: string, aggregateId: string) {
      const state = cells.get(`${aggregateType}:${aggregateId}`);
      return state === undefined ? null : { state };
    },
    emit(type: string, payload: Json): string {
      events.push({ type, payload });
      return `evt-${String(events.length).padStart(12, "0")}`;
    },
    events: () => events,
  };
}

interface BroadcastRecord {
  readonly fromId: string;
  readonly originNodeId?: string;
}

/** 构造只记录剧情广播的端口桩与最小处理器上下文。 */
function contextWith(
  content: GameContent,
  tx: MemoryTx,
): { readonly context: HandlerContext<GameModulePorts, unknown>; readonly broadcasts: readonly BroadcastRecord[] } {
  const broadcasts: BroadcastRecord[] = [];
  const modules = {
    "game.comms": {
      postMessage: (input: { fromId: string; originNodeId?: string }) => {
        broadcasts.push({ fromId: input.fromId, originNodeId: input.originNodeId });
        return { messageId: "msg-1" };
      },
    },
  } as unknown as GameModulePorts;
  const context = {
    auth: {} as never,
    tx,
    modules,
    approvedSpeech: {} as never,
    content,
    rng: () => () => 0.5,
    ids: () => "gen-000000000001",
  } as unknown as HandlerContext<GameModulePorts, unknown>;
  return { context, broadcasts };
}

/** 以已发布状态种下一张剧情卡。 */
function seedPublishedCard(
  tx: MemoryTx,
  cardId: string,
  effects: readonly CardEffect[],
): void {
  tx.put("scenario-card", cardId, {
    cardId,
    version: 1,
    status: "published",
    triggerAtTick: 5,
    effects: [...effects],
    note: "test",
  });
}

describe("剧情元数据驱动", () => {
  it("剧情卡广播的发布节点来自 broadcastOriginNodeId 声明", () => {
    const effects: readonly CardEffect[] = [{ kind: "broadcast", speakerId: "npc-signer", text: "alarm" }];
    const content = contentWith({ broadcastOriginNodeId: "declared-node" });
    const tx = makeMemoryTx();
    const { context, broadcasts } = contextWith(content, tx);
    seedPublishedCard(tx, "card-alarm", effects);
    const job = requireCardJob(createScenarioContributor({ escalating: false }));
    job.handler(context, { payload: { cardId: "card-alarm", version: 1 } } as never);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.originNodeId).toBe("declared-node");
    expect(tx.events().some((event) => event.type === "ScenarioCardTriggered")).toBe(true);
  });

  it("压力卡标记由 pressureCardId 声明驱动而不是固定卡片", () => {
    const effects: readonly CardEffect[] = [{ kind: "broadcast", speakerId: "npc-signer", text: "alarm" }];
    const job = requireCardJob(createScenarioContributor({ escalating: false }));
    // 压力卡声明为 card-alarm：触发它置位压力标记。
    const declared = contentWith({ pressureCardId: "card-alarm" });
    const declaredTx = makeMemoryTx();
    const declaredContext = contextWith(declared, declaredTx).context;
    seedPublishedCard(declaredTx, "card-alarm", effects);
    job.handler(declaredContext, { payload: { cardId: "card-alarm", version: 1 } } as never);
    const declaredRun = declaredTx.get("scenario-run", "test-scenario");
    expect((declaredRun?.state as { alarmTriggered?: boolean } | undefined)?.alarmTriggered).toBe(true);

    // 同一张卡在压力卡声明为 card-other 时不置位压力标记。
    const otherDeclared = contentWith({ pressureCardId: "card-other" });
    const otherTx = makeMemoryTx();
    const otherContext = contextWith(otherDeclared, otherTx).context;
    seedPublishedCard(otherTx, "card-alarm", effects);
    job.handler(otherContext, { payload: { cardId: "card-alarm", version: 1 } } as never);
    const otherRun = otherTx.get("scenario-run", "test-scenario");
    // 非压力卡触发不会创建或置位压力标记；只在真正的压力卡触发时出现。
    const alarmTriggered =
      (otherRun?.state as { alarmTriggered?: boolean } | undefined)?.alarmTriggered === true;
    expect(alarmTriggered).toBe(false);
  });

  it("signature-only 署名由剧情名单校验", () => {
    const declared = contentWith({ signatureOnlyPrincipalIds: ["npc-signer"] });
    const signerEffects: readonly CardEffect[] = [
      { kind: "broadcast", speakerId: "npc-signer", text: "t" },
    ];
    expect(invalidEffectReferences(declared, signerEffects)).toBeNull();

    const unknownEffects: readonly CardEffect[] = [
      { kind: "broadcast", speakerId: "npc-stranger", text: "t" },
    ];
    expect(invalidEffectReferences(declared, unknownEffects)).toBe("广播署名 npc-stranger");
  });
});
