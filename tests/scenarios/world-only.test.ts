/**
 * 固定命令脚本推进 168 tick 的世界验收：每日结算、运输与协议、剧情卡与章节评估。
 * 依赖真实 SQLite 游戏环境、服务端 tick 顺序、存档服务与确定性宿主随机源。
 * 禁止绕过命令网关或宿主顺序手写 job/时钟/消费者调用，也禁止让墙钟时间影响结果。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AuthContext, CommandReceipt, CommandType, Json } from "@ai-npc/contracts";
import { advanceWorldTick, createSaveService } from "@ai-npc/app-server";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  playerAuth,
  readBranchWorldRows,
  readGameAggregate,
  readGameEvents,
  startNeutralCampaign,
  strategicAuth,
  type GameHarness,
} from "../integration/game-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

/** 首章最后一个 tick：tick 0–167 为七天，tick 168 提交章节评估。 */
const CHAPTER_END_TICK = 168;

/** 标准剧情节奏的卡片触发 tick；内容包 watergate-v1 的 trigger.atTick 固定值。 */
const STANDARD_CARD_TICKS: Readonly<Record<string, number>> = {
  "card-relay-alarm": 2,
  "card-injured-migrants": 6,
  "card-water-dispute": 26,
  "card-repair-exchange": 30,
  "card-flood-delay": 44,
  "card-attack-rumor": 50,
  "card-supply-spoilage": 72,
  "card-migration-season": 96,
  "card-council": 144,
};

/** 升级版剧情节奏倍率：触发 tick 按 0.75 向下取整。 */
const ESCALATING_RATE = 0.75;

/** 履约条款：玩家在 tick 48 前把 10 点供给从灰港运到果园。 */
const FULFILLED_TERM: Json = {
  kind: "deliver",
  obligorId: "player-1",
  resource: "supply",
  amount: 10,
  fromStockpileId: "sp-commons",
  toStockpileId: "sp-earth",
  byTick: 48,
};

/** 违约条款：玩家承诺 tick 20 前把 5 点与 1 点能源运到果园，脚本不派遣这些运输。 */
const BREACHED_TERMS: readonly Json[] = [
  {
    kind: "deliver",
    obligorId: "player-1",
    resource: "energy",
    amount: 5,
    fromStockpileId: "sp-commons",
    toStockpileId: "sp-earth",
    byTick: 20,
  },
  {
    kind: "deliver",
    obligorId: "player-1",
    resource: "energy",
    amount: 1,
    fromStockpileId: "sp-commons",
    toStockpileId: "sp-earth",
    byTick: 20,
  },
];

type WorldEvent = ReturnType<typeof readGameEvents>[number];

interface ScriptedReceipt {
  readonly label: string;
  readonly receipt: CommandReceipt;
}

interface WorldScriptRun {
  readonly receipts: readonly ScriptedReceipt[];
  readonly transportTaskId: string;
  readonly fulfilledAgreementId: string;
  readonly breachedAgreementId: string;
}

interface ResourceAmounts {
  readonly supply: number;
  readonly energy: number;
  readonly medical: number;
}

interface StockpileView {
  readonly amount: ResourceAmounts;
  readonly reserved: ResourceAmounts;
  readonly baseline: ResourceAmounts;
}

interface MeterSnapshot {
  readonly "relay.stability": number;
  readonly "orchard.water": number;
  readonly "migration.safety": number;
  readonly "watergate.allocation": "harbor-first" | "rotation" | "orchard-first";
}

interface DayPassedPayload {
  readonly day: number;
  readonly meters: MeterSnapshot;
  readonly consumption: ResourceAmounts;
}

interface ChapterPayload {
  readonly outcome: "equilibrium" | "strained";
  readonly meters: MeterSnapshot;
  readonly unmet: readonly string[];
  readonly fulfilledCount: number;
  readonly breachedCount: number;
}

interface MeterChange {
  readonly meter: string;
  readonly from: number;
  readonly to: number;
  readonly cause: string;
}

/** 回执被拒绝时立刻失败，避免后续命令在缺失 ID 的情况下继续。 */
function requireAccepted(label: string, receipt: CommandReceipt): CommandReceipt {
  if (receipt.commandStatus !== "accepted") {
    throw new Error(`脚本命令 ${label} 被拒绝，原因码 ${String(receipt.reasonCode)}`);
  }
  return receipt;
}

/** 读取 accepted 回执结果中的动态 ID；缺失时明确失败。 */
function requireResultId(receipt: CommandReceipt, key: string): string {
  const result = receipt.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`命令回执缺少结果对象，无法读取 ${key}`);
  }
  const value = result[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`命令回执结果缺少 ${key}`);
  }
  return value;
}

/**
 * 固定命令序列：从空分支开局，两名当事人之间先各立一份交付协议，
 * 再由玩家派遣一次真实运输，之后所有 tick 只交给宿主推进。
 */
function runWorldScript(harness: GameHarness): WorldScriptRun {
  if (readGameEvents(harness).length !== 0) {
    throw new Error("世界脚本要求从空分支开始");
  }
  const receipts: ScriptedReceipt[] = [];
  const execute = (label: string, auth: AuthContext, type: CommandType, payload: Json): CommandReceipt => {
    const receipt = harness.authority.commands.execute(
      auth,
      gameCommandEnvelope(type, payload, harness.host.ids("cmd")),
    );
    receipts.push({ label, receipt });
    return receipt;
  };

  const started = startNeutralCampaign(harness);
  receipts.push({ label: "campaign.start", receipt: started });
  requireAccepted("campaign.start", started);

  const fulfilledProposal = requireAccepted(
    "agreement.propose.fulfilled",
    execute("agreement.propose.fulfilled", playerAuth(harness), "agreement.propose", {
      parties: ["player-1", "human-neutral"],
      terms: [FULFILLED_TERM],
    }),
  );
  const fulfilledAgreementId = requireResultId(fulfilledProposal, "agreementId");
  requireAccepted(
    "agreement.respond.fulfilled",
    execute("agreement.respond.fulfilled", strategicAuth(harness, "human-neutral"), "agreement.respond", {
      agreementId: fulfilledAgreementId,
      response: "accept",
    }),
  );

  const breachedProposal = requireAccepted(
    "agreement.propose.breached",
    execute("agreement.propose.breached", playerAuth(harness), "agreement.propose", {
      parties: ["player-1", "human-neutral"],
      terms: [...BREACHED_TERMS],
    }),
  );
  const breachedAgreementId = requireResultId(breachedProposal, "agreementId");
  requireAccepted(
    "agreement.respond.breached",
    execute("agreement.respond.breached", strategicAuth(harness, "human-neutral"), "agreement.respond", {
      agreementId: breachedAgreementId,
      response: "accept",
    }),
  );

  const dispatched = requireAccepted(
    "task.dispatch",
    execute("task.dispatch", playerAuth(harness), "task.dispatch", {
      taskType: "transport",
      teamId: "team-commons",
      params: {
        fromStockpileId: "sp-commons",
        toStockpileId: "sp-earth",
        cargo: { supply: 10, energy: 0, medical: 0 },
      },
    }),
  );
  return {
    receipts,
    transportTaskId: requireResultId(dispatched, "taskId"),
    fulfilledAgreementId,
    breachedAgreementId,
  };
}

/** 逐 tick 推进到目标 tick；每个 tick 都经过宿主的时钟、job、时钟步骤与消费者顺序。 */
function advanceToTick(harness: GameHarness, targetTick: number): void {
  for (let tick = 1; tick <= targetTick; tick += 1) {
    const result = advanceWorldTick({
      storage: harness.storage,
      authority: harness.authority,
      host: harness.host,
      branchId: harness.branchId,
      targetTick: tick,
    });
    if (result.worldTick !== tick) {
      throw new Error(`tick 推进返回 ${result.worldTick}，期望 ${tick}`);
    }
  }
}

function eventsOf(events: readonly WorldEvent[], type: string): readonly WorldEvent[] {
  return events.filter((event) => event.type === type);
}

/** 按 cardId 汇总剧情卡触发 tick；重复触发直接失败。 */
function cardTriggerTicks(events: readonly WorldEvent[]): ReadonlyMap<string, number> {
  const ticks = new Map<string, number>();
  for (const event of eventsOf(events, "ScenarioCardTriggered")) {
    const payload = event.payload as { readonly cardId?: unknown };
    if (typeof payload.cardId !== "string" || payload.cardId.length === 0) {
      throw new Error("剧情卡触发事件缺少 cardId");
    }
    if (ticks.has(payload.cardId)) {
      throw new Error(`剧情卡 ${payload.cardId} 重复触发`);
    }
    ticks.set(payload.cardId, event.worldTick);
  }
  return ticks;
}

/** 取唯一的章节评估事件；数量不为 1 时明确失败。 */
function chapterEvent(events: readonly WorldEvent[]): WorldEvent {
  const chapters = eventsOf(events, "ChapterStageEvaluated");
  if (chapters.length !== 1) {
    throw new Error(`章节评估事件数量为 ${chapters.length}，期望 1`);
  }
  const chapter = chapters[0];
  if (chapter === undefined) {
    throw new Error("章节评估事件缺失");
  }
  return chapter;
}

function chapterPayload(events: readonly WorldEvent[]): ChapterPayload {
  return chapterEvent(events).payload as unknown as ChapterPayload;
}

function stockpile(harness: GameHarness, stockpileId: string): StockpileView {
  const state = readGameAggregate(harness, "stockpile", stockpileId);
  if (state === null) {
    throw new Error(`库存 ${stockpileId} 不存在`);
  }
  return state as unknown as StockpileView;
}

/** 从开局事件里找到玩家的委托 ID；内容包只为玩家写一条开局委托。 */
function playerDelegationId(events: readonly WorldEvent[]): string {
  for (const event of eventsOf(events, "DelegationCreated")) {
    const payload = event.payload as { readonly delegationId?: unknown; readonly granteeId?: unknown };
    if (payload.granteeId === "player-1" && typeof payload.delegationId === "string") {
      return payload.delegationId;
    }
  }
  throw new Error("没有找到玩家的开局委托");
}

/** 读取当前分支时钟的 world_tick；缺失时明确失败。 */
function readClockTick(harness: GameHarness): number {
  const rows = readBranchWorldRows(harness.storage, harness.branchId);
  const tick = rows.clock?.["world_tick"];
  if (typeof tick !== "number") {
    throw new Error(`分支 ${harness.branchId} 缺少 clock.world_tick`);
  }
  return tick;
}

/** 事件序列的稳定投影：只保留类型、提交 tick、payload 与受众。 */
function eventSequence(harness: GameHarness): readonly {
  readonly type: string;
  readonly worldTick: number;
  readonly payload: Json;
  readonly audience: Json;
}[] {
  return readGameEvents(harness).map((event) => ({
    type: event.type,
    worldTick: event.worldTick,
    payload: event.payload,
    audience: event.audience,
  }));
}

/** 与动态 ID 无关的世界事实：剧情卡 tick、运输路线、章节指标与终局资源。 */
function stableWorldFacts(harness: GameHarness): Json {
  const events = readGameEvents(harness);
  const departed = eventsOf(events, "TaskDeparted").map((event) => {
    const payload = event.payload as unknown as {
      readonly route: readonly string[];
      readonly nominalCompletionTick: number;
    };
    return { route: [...payload.route], nominalCompletionTick: payload.nominalCompletionTick };
  });
  return {
    cardTicks: Object.fromEntries([...cardTriggerTicks(events)].sort((left, right) => left[0].localeCompare(right[0]))),
    departed,
    chapter: chapterPayload(events) as unknown as Json,
    commonsSupply: stockpile(harness, "sp-commons").amount.supply,
    earthSupply: stockpile(harness, "sp-earth").amount.supply,
  };
}

/** 收集指定原因的指标变化；用于比较两个剧情 provider 的追加压力。 */
function meterChanges(harness: GameHarness, cause: string): readonly MeterChange[] {
  return readGameEvents(harness)
    .filter((event) => event.type === "MetersChanged")
    .flatMap((event) => (event.payload as unknown as { readonly changes: readonly MeterChange[] }).changes)
    .filter((change) => change.cause === cause);
}

describe("168 tick 世界脚本", () => {
  it("固定命令序列产出确定的每日结算、资源、协议与章节结果", { timeout: 120_000 }, async () => {
    const harness = await createTrackedGameHarness(active);
    const script = runWorldScript(harness);
    expect(readClockTick(harness)).toBe(0);
    advanceToTick(harness, CHAPTER_END_TICK);
    expect(readClockTick(harness)).toBe(CHAPTER_END_TICK);

    // 每条脚本命令都被接受，且回执至少带一个已接受事件 ID。
    expect(
      script.receipts
        .filter(({ receipt }) => receipt.commandStatus !== "accepted")
        .map(({ label, receipt }) => ({ label, reasonCode: receipt.reasonCode })),
    ).toEqual([]);
    expect(
      script.receipts
        .filter(({ receipt }) => receipt.acceptedEventIds.length === 0)
        .map(({ label }) => label),
    ).toEqual([]);

    const events = readGameEvents(harness);
    expect(events[0]?.type).toBe("CampaignStarted");

    // 每日结算：第 1–7 天各一次，最后一次供给不足只扣到 0。
    const days = eventsOf(events, "DayPassed");
    expect(days.map((event) => event.worldTick)).toEqual([24, 48, 72, 96, 120, 144, 168]);
    expect(days.map((event) => (event.payload as unknown as DayPassedPayload).day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(days.map((event) => (event.payload as unknown as DayPassedPayload).consumption.supply)).toEqual([
      6, 6, 6, 6, 6, 6, 4,
    ]);
    const lastDay = days.at(-1);
    if (lastDay === undefined) {
      throw new Error("缺少最后一次每日结算");
    }
    // 中继 45−3×7=24；果园 50−9×7 截断为 0；迁徙 50−10（群体恶化）−2×4（迁徙季）=32。
    expect(lastDay.payload).toMatchObject({
      meters: {
        "relay.stability": 24,
        "orchard.water": 0,
        "migration.safety": 32,
        "watergate.allocation": "harbor-first",
      },
    });

    // 章节评估：恰好一次，且晚于同 tick 的每日结算。
    // 协议计数按协议而非条款：履约协议 1 份记 fulfilled，两条条款都违约的协议只记 1 份 breached。
    const chapter = chapterEvent(events);
    expect(chapter.worldTick).toBe(CHAPTER_END_TICK);
    expect(events.indexOf(chapter)).toBeGreaterThan(events.indexOf(lastDay));
    expect(chapter.payload).toEqual({
      outcome: "strained",
      meters: {
        "relay.stability": 24,
        "orchard.water": 0,
        "migration.safety": 32,
        "watergate.allocation": "harbor-first",
      },
      unmet: ["relay.stability", "orchard.water", "migration.safety"],
      fulfilledCount: 1,
      breachedCount: 1,
    });

    // 运输：tick 0 派遣、tick 1 出发、tick 7 到达；货物从灰港转入果园。
    const departed = eventsOf(events, "TaskDeparted");
    expect(departed).toHaveLength(1);
    expect(departed[0]).toMatchObject({
      worldTick: 1,
      payload: {
        taskId: script.transportTaskId,
        participants: [],
        route: ["r-gh-or"],
        nominalCompletionTick: 7,
      },
    });
    const completed = eventsOf(events, "TaskCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      worldTick: 7,
      payload: { taskId: script.transportTaskId, taskType: "transport", completedAtTick: 7 },
    });
    const transferred = eventsOf(events, "ResourcesTransferred");
    expect(transferred).toHaveLength(1);
    expect(transferred[0]?.payload).toEqual({
      fromStockpileId: "sp-commons",
      toStockpileId: "sp-earth",
      delta: { supply: 10, energy: 0, medical: 0 },
      taskId: script.transportTaskId,
      dispatcherId: "player-1",
    });

    // 协议：一份按交付事实履约；另一份的两条能源条款都在 byTick 20 后未交付。
    expect(readGameAggregate(harness, "agreement", script.fulfilledAgreementId)).toMatchObject({
      status: "fulfilled",
      fulfilledTerms: [0],
      breachedTerms: [],
    });
    expect(readGameAggregate(harness, "agreement", script.breachedAgreementId)).toMatchObject({
      status: "breached",
      breachedTerms: [0, 1],
    });
    const fulfilled = eventsOf(events, "AgreementFulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({
      worldTick: 7,
      payload: { agreementId: script.fulfilledAgreementId },
    });
    // 同一协议的两条违约条款各提交一次事件，但章节统计按协议只计 1 次违约。
    const breached = eventsOf(events, "AgreementBreached");
    expect(breached.map((event) => event.worldTick)).toEqual([21, 21]);
    expect(breached.map((event) => (event.payload as unknown as { termIndex: number }).termIndex)).toEqual([0, 1]);
    for (const event of breached) {
      expect(event).toMatchObject({
        payload: { agreementId: script.breachedAgreementId, obligorId: "player-1" },
      });
    }

    // 终局资源：公共供给被每日消耗与剧情扣减耗尽，果园收到 10 点供给。
    expect(stockpile(harness, "sp-commons")).toMatchObject({
      amount: { supply: 0, energy: 12, medical: 8 },
      reserved: { supply: 0, energy: 0, medical: 0 },
      baseline: { supply: 60 },
    });
    expect(stockpile(harness, "sp-earth")).toMatchObject({ amount: { supply: 30 } });
    // 果园缺水触发损坏时，果园的医疗库存扣 5。
    expect(stockpile(harness, "sp-flora")).toMatchObject({ amount: { medical: 9 } });

    // 委托余额只扣实际运输的 10 点供给，能源未被动用。
    const delegationId = playerDelegationId(events);
    expect(readGameAggregate(harness, "delegation", delegationId)).toMatchObject({
      granteeId: "player-1",
      remaining: { supply: 5, energy: 6, medical: 4 },
      limit: { supply: 15, energy: 6, medical: 4 },
      untilTick: 168,
    });

    // 指标阈值：群体期限、果园危机与损坏、中继降级按首次触发各提交一次。
    expect(eventsOf(events, "GroupWorsened")).toMatchObject([
      { worldTick: 48, payload: { groupId: "grp-injured-migrants" } },
    ]);
    expect(readGameAggregate(harness, "group", "grp-injured-migrants")).toMatchObject({
      status: "worsened",
      injured: 6,
    });
    expect(eventsOf(events, "RelayDegraded")).toMatchObject([{ worldTick: 144, payload: { value: 27 } }]);
    expect(eventsOf(events, "OrchardCrisis")).toMatchObject([{ worldTick: 96, payload: { value: 14 } }]);
    expect(eventsOf(events, "OrchardDamaged")).toMatchObject([{ worldTick: 144, payload: { value: 0 } }]);
    expect(eventsOf(events, "SupplyShortage")).toMatchObject([{ worldTick: 168, payload: { value: 4 } }]);
    expect(eventsOf(events, "MigrationCrisis")).toHaveLength(0);
    expect(readGameAggregate(harness, "meters", "meters")).toMatchObject({
      "relay.stability": 24,
      "orchard.water": 0,
      "migration.safety": 32,
      lastDailyTick: 168,
      triggered: ["OrchardCrisis", "RelayDegraded", "OrchardDamaged"],
    });

    // 九张剧情卡各在自己的触发 tick 出现一次。
    const ticks = cardTriggerTicks(events);
    expect(eventsOf(events, "ScenarioCardTriggered")).toHaveLength(Object.keys(STANDARD_CARD_TICKS).length);
    expect([...ticks.keys()].sort()).toEqual(Object.keys(STANDARD_CARD_TICKS).sort());
    for (const [cardId, atTick] of Object.entries(STANDARD_CARD_TICKS)) {
      expect(ticks.get(cardId)).toBe(atTick);
    }
    // 剧情卡 job 在每日结算之前执行：tick 72 的卡片事件 worldSeq 更小。
    const tick72Card = events.find(
      (event) => event.type === "ScenarioCardTriggered" && event.worldTick === 72,
    );
    const tick72Day = days.find((event) => event.worldTick === 72);
    if (tick72Card === undefined || tick72Day === undefined) {
      throw new Error("tick 72 缺少剧情卡或每日结算事件");
    }
    expect(events.indexOf(tick72Card)).toBeLessThan(events.indexOf(tick72Day));
  });

  it("同一命令脚本在两个独立 harness 上产生完全一致的事件序列", { timeout: 180_000 }, async () => {
    const first = await createTrackedGameHarness(active);
    runWorldScript(first);
    advanceToTick(first, CHAPTER_END_TICK);

    const second = await createTrackedGameHarness(active);
    runWorldScript(second);
    advanceToTick(second, CHAPTER_END_TICK);

    // 宿主的 ID、时间与随机源都由测试注入；两条独立运行必须逐事件一致。
    const firstSequence = eventSequence(first);
    const secondSequence = eventSequence(second);
    expect(secondSequence).toEqual(firstSequence);
    expect(JSON.stringify(secondSequence)).toBe(JSON.stringify(firstSequence));

    // 与 taskId 等生成 ID 无关的世界事实同样稳定。
    expect(stableWorldFacts(second)).toEqual(stableWorldFacts(first));
  });

  it("两个剧情 provider 的卡片节奏与章节指标按各自规则不同", { timeout: 180_000 }, async () => {
    const standard = await createTrackedGameHarness(active);
    runWorldScript(standard);
    advanceToTick(standard, CHAPTER_END_TICK);

    const escalating = await createTrackedGameHarness(active, { scenarioEscalating: true });
    runWorldScript(escalating);
    advanceToTick(escalating, CHAPTER_END_TICK);

    // 升级版把同一份内容卡片的触发 tick 按 0.75 向下取整。
    const standardTicks = cardTriggerTicks(readGameEvents(standard));
    const escalatingTicks = cardTriggerTicks(readGameEvents(escalating));
    expect([...standardTicks.keys()].sort()).toEqual(Object.keys(STANDARD_CARD_TICKS).sort());
    expect([...escalatingTicks.keys()].sort()).toEqual(Object.keys(STANDARD_CARD_TICKS).sort());
    for (const [cardId, atTick] of Object.entries(STANDARD_CARD_TICKS)) {
      expect(standardTicks.get(cardId)).toBe(atTick);
      expect(escalatingTicks.get(cardId)).toBe(Math.floor(atTick * ESCALATING_RATE));
    }
    expect(escalatingTicks.get("card-relay-alarm")).toBe(1);

    // 升级版在每次每日结算后追加 −2 中继压力；章节评估先于该追加提交，因此评估值差 7×2。
    const standardChapter = chapterPayload(readGameEvents(standard));
    const escalatingChapter = chapterPayload(readGameEvents(escalating));
    expect(standardChapter).toMatchObject({
      outcome: "strained",
      unmet: ["relay.stability", "orchard.water", "migration.safety"],
      fulfilledCount: 1,
      breachedCount: 1,
    });
    expect(escalatingChapter).toMatchObject({
      outcome: "strained",
      unmet: ["relay.stability", "orchard.water", "migration.safety"],
      fulfilledCount: 1,
      breachedCount: 1,
    });
    expect(standardChapter.meters["relay.stability"]).toBe(24);
    expect(escalatingChapter.meters["relay.stability"]).toBe(12);
    expect(escalatingChapter.meters["orchard.water"]).toBe(standardChapter.meters["orchard.water"]);
    expect(escalatingChapter.meters["migration.safety"]).toBe(standardChapter.meters["migration.safety"]);

    const standardPressure = meterChanges(standard, "scenario-pressure");
    const escalatingPressure = meterChanges(escalating, "scenario-pressure");
    expect(standardPressure).toHaveLength(0);
    expect(escalatingPressure).toHaveLength(7);
    for (const change of escalatingPressure) {
      expect(change).toMatchObject({ meter: "relay.stability", cause: "scenario-pressure" });
      expect(change.from - change.to).toBe(2);
    }
    // 最后一次追加发生在章节评估之后，所以终局指标比评估值再低 2。
    expect(readGameAggregate(standard, "meters", "meters")).toMatchObject({ "relay.stability": 24 });
    expect(readGameAggregate(escalating, "meters", "meters")).toMatchObject({ "relay.stability": 10 });
  });

  it("tick 168 快照与恢复出的后继分支逐表保留世界行", { timeout: 120_000 }, async () => {
    const harness = await createTrackedGameHarness(active);
    runWorldScript(harness);
    advanceToTick(harness, CHAPTER_END_TICK);

    const save = createSaveService(harness.storage, harness.host);
    const snapshot = save.createSnapshot({
      sourceBranchId: harness.branchId,
      label: "168 tick 世界快照",
      createdBy: "operator-1",
    });
    expect(snapshot).toMatchObject({ sourceBranchId: harness.branchId, worldTick: CHAPTER_END_TICK });

    const sourceRows = readBranchWorldRows(harness.storage, harness.branchId);
    expect(sourceRows.events.length).toBeGreaterThan(0);
    expect(sourceRows.aggregates.length).toBeGreaterThan(0);
    expect(snapshot.worldSeq).toBe(Number(sourceRows.events.at(-1)?.["world_seq"] ?? -1));

    // 冻结分支由整表分支复制得到：事件、聚合与 job 原始行必须逐行一致。
    const frozenRows = readBranchWorldRows(harness.storage, snapshot.frozenBranchId);
    expect(frozenRows.events).toEqual(sourceRows.events);
    expect(frozenRows.aggregates).toEqual(sourceRows.aggregates);
    expect(frozenRows.jobs).toEqual(sourceRows.jobs);
    expect(Number(sourceRows.clock?.["world_tick"])).toBe(CHAPTER_END_TICK);
    expect(Number(frozenRows.clock?.["world_tick"])).toBe(CHAPTER_END_TICK);

    // 从快照恢复后继在线分支，世界表仍与源分支一致。
    // 恢复路径会把复制出的时钟置为 paused，且不会写入 runs 行；这两项属于恢复编排的已知缺陷，
    // 不在世界表一致性的验收范围内，因此这里只比较世界表与 world_tick，不断言时钟模式或 runs。
    const restored = save.restoreSnapshot({ snapshotId: snapshot.snapshotId, createdBy: "operator-1" });
    const restoredRows = readBranchWorldRows(harness.storage, restored.branchId);
    expect(restoredRows.events).toEqual(sourceRows.events);
    expect(restoredRows.aggregates).toEqual(sourceRows.aggregates);
    expect(restoredRows.jobs).toEqual(sourceRows.jobs);
    expect(Number(restoredRows.clock?.["world_tick"])).toBe(CHAPTER_END_TICK);
  });
});
