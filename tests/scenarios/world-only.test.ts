/**
 * 固定命令脚本推进 168 tick 的世界验收：每日结算、运输与协议、剧情卡与章节评估。
 * 依赖真实 SQLite 游戏环境、服务端 tick 顺序、存档服务与确定性宿主随机源。
 * 禁止绕过命令网关或宿主顺序手写 job/时钟/消费者调用，也禁止让墙钟时间影响结果。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSaveService } from "@ai-npc/app-server";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  readBranchWorldRows,
  readGameAggregate,
  readGameEvents,
  type GameHarness,
} from "../integration/game-support";
import {
  advanceToTick,
  cardTriggerTicks,
  chapterEvent,
  chapterPayload,
  CHAPTER_END_TICK,
  createWorldAtChapterEnd,
  ESCALATING_RATE,
  eventSequence,
  eventsOf,
  meterChanges,
  playerDelegationId,
  readClockTick,
  runWorldScript,
  stableWorldFacts,
  STANDARD_CARD_TICKS,
  stockpile,
  type DayPassedPayload,
} from "./world-only-support";

const active: GameHarness[] = [];

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

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
    const first = await createWorldAtChapterEnd(active);
    const second = await createWorldAtChapterEnd(active);

    // 宿主的 ID、时间与随机源都由测试注入；两条独立运行必须逐事件一致。
    const firstSequence = eventSequence(first);
    const secondSequence = eventSequence(second);
    expect(secondSequence).toEqual(firstSequence);
    expect(JSON.stringify(secondSequence)).toBe(JSON.stringify(firstSequence));

    // 与 taskId 等生成 ID 无关的世界事实同样稳定。
    expect(stableWorldFacts(second)).toEqual(stableWorldFacts(first));
  });

  it("两个剧情 provider 的卡片节奏与章节指标按各自规则不同", { timeout: 180_000 }, async () => {
    const standard = await createWorldAtChapterEnd(active);
    const escalating = await createWorldAtChapterEnd(active, { scenarioEscalating: true });

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
    const harness = await createWorldAtChapterEnd(active);

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

    // 从快照复制后继在线分支：本用例只比较世界表，直接使用存储端口的整表分支复制；
    // 在线恢复编排（写 runs、结束旧 run、归档旧分支并切换 world_aliases('online')）由宿主入口验证。
    const restoredBranchId = harness.host.ids("br");
    harness.storage.transact((tx) => {
      harness.storage.forkBranch(tx, {
        srcBranchId: snapshot.frozenBranchId,
        dstBranchId: restoredBranchId,
        kind: "online",
        runId: harness.host.ids("run"),
      });
    });
    const restoredRows = readBranchWorldRows(harness.storage, restoredBranchId);
    expect(restoredRows.events).toEqual(sourceRows.events);
    expect(restoredRows.aggregates).toEqual(sourceRows.aggregates);
    expect(restoredRows.jobs).toEqual(sourceRows.jobs);
    expect(Number(restoredRows.clock?.["world_tick"])).toBe(CHAPTER_END_TICK);
  });
});
