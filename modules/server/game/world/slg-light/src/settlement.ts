/**
 * 执行每日结算与章节评估：计算指标、消耗公共供给、触发阈值并写入结果事件。
 * 依赖世界/资源/地图端口、世界聚合与内容初始值；所有变化在 authority 提供的事务内完成。
 * 禁止重复结算同一 tick、在事务内调用模型或把未达标的指标算作均衡。
 */
import type { MeterChange, MeterChangeCause, NumericMeterId } from "@ai-npc/contracts";
import type { GameModulePorts, HandlerContext } from "@ai-npc/module-sdk";
import { requireGameContent, type MetersView } from "@ai-npc/module-sdk";
import { clampMeter, metersSnapshot, thresholdEvents } from "./meters";
import {
  campaignStateSchema,
  chapterStatsStateSchema,
  metersStateSchema,
  readWorldState,
  type CampaignState,
  type ChapterStatsState,
  type MetersState,
} from "./state";

type WorldContext = HandlerContext<GameModulePorts, unknown>;

function metersView(state: MetersState): MetersView {
  return {
    "relay.stability": state["relay.stability"],
    "orchard.water": state["orchard.water"],
    "migration.safety": state["migration.safety"],
    "watergate.allocation": state["watergate.allocation"],
  };
}

function addChange(
  changes: MeterChange[],
  meter: NumericMeterId,
  from: number,
  to: number,
  cause: MeterChangeCause,
): void {
  if (from !== to) {
    changes.push({ meter, from, to, cause });
  }
}

/** 计算每日指标变化；返回新指标与变化列表。 */
function computeDaily(
  previous: MetersView,
  tick: number,
  elapsed: number,
  modules: GameModulePorts,
): { readonly next: MetersView; readonly changes: MeterChange[] } {
  const changes: MeterChange[] = [];
  const allocation = previous["watergate.allocation"];
  const relayDelta = allocation === "harbor-first" ? -3 : allocation === "rotation" ? -5 : -8;
  const orchardDelta = allocation === "harbor-first" ? -9 : allocation === "rotation" ? -2 : 5;
  let migrationDelta = 0;
  if (elapsed >= 96) {
    const status = modules["game.map"].roadStatus("r-gh-ps");
    if (status === "closed") {
      migrationDelta = -10;
    } else if (
      status === "restricted" &&
      !modules["game.map"].hasPassage("r-gh-ps", "species-fauna", tick)
    ) {
      migrationDelta = -6;
    } else {
      migrationDelta = -2;
    }
  }
  const relay = clampMeter(previous["relay.stability"] + relayDelta);
  const orchard = clampMeter(previous["orchard.water"] + orchardDelta);
  const migration = clampMeter(previous["migration.safety"] + migrationDelta);
  addChange(changes, "relay.stability", previous["relay.stability"], relay, "daily");
  addChange(changes, "orchard.water", previous["orchard.water"], orchard, "daily");
  addChange(changes, "migration.safety", previous["migration.safety"], migration, "daily");
  return {
    next: {
      "relay.stability": relay,
      "orchard.water": orchard,
      "migration.safety": migration,
      "watergate.allocation": allocation,
    },
    changes,
  };
}

/** 在每日结算事务内执行一次；已结算的 tick 或未到结算日直接返回。 */
export function runDailySettlement(context: WorldContext, tick: number): void {
  const campaignRecord = readWorldState(context.tx, "campaign", "campaign", campaignStateSchema);
  if (campaignRecord === null) {
    return;
  }
  const elapsed = tick - campaignRecord.state.startTick;
  if (elapsed <= 0 || elapsed % 24 !== 0) {
    return;
  }
  const record = readWorldState(context.tx, "meters", "meters", metersStateSchema);
  if (record === null) {
    return;
  }
  const state = record.state;
  if (state.lastDailyTick === tick) {
    return;
  }
  const content = requireGameContent(context.content);
  const modules = context.modules;
  const previous = metersView(state);
  const { next, changes } = computeDaily(previous, tick, elapsed, modules);
  const threshold = thresholdEvents(previous, next, new Set(state.triggered));
  const triggered = [...state.triggered, ...threshold.added];
  const day = elapsed / 24;
  context.tx.put("meters", "meters", {
    ...next,
    triggered,
    lastDailyTick: tick,
  });

  if (changes.length > 0) {
    context.tx.emit("MetersChanged", { changes }, [{ kind: "public" }]);
  }
  for (const event of threshold.events) {
    context.tx.emit(event.type, { value: event.value }, [{ kind: "public" }]);
  }

  const commons = content.stockpiles.get("sp-commons");
  const availableSupply = commons === undefined ? 0 : modules["game.resources"].available("sp-commons", "supply");
  const consumedSupply = Math.min(6, Math.max(0, availableSupply));
  if (consumedSupply > 0) {
    modules["game.resources"].consume({
      stockpileId: "sp-commons",
      delta: { supply: consumedSupply, energy: 0, medical: 0 },
      reason: "daily-consumption",
      taskId: null,
      byId: "system:world",
      fromReservation: false,
    });
  }
  if (consumedSupply < 6) {
    context.tx.emit("SupplyShortage", { value: consumedSupply }, [{ kind: "public" }]);
  }
  if (next["orchard.water"] === 0 && threshold.added.includes("OrchardDamaged")) {
    if (content.stockpiles.has("sp-flora")) {
      modules["game.resources"].adjust({
        stockpileId: "sp-flora",
        delta: { medical: -5 },
        reason: "orchard-damage",
      });
    }
  }
  context.tx.emit(
    "DayPassed",
    {
      day,
      meters: metersSnapshot(next),
      consumption: { supply: consumedSupply, energy: 0, medical: 0 },
      changes,
    },
    [{ kind: "public" }],
  );
}

/** 在章节评估事务内执行一次；未到章节长度或已评估的 campaign 直接返回。 */
export function runChapterEvaluation(context: WorldContext, chapterLengthTicks = 168): void {
  const record = readWorldState(context.tx, "campaign", "campaign", campaignStateSchema);
  if (record === null || record.state.status === "evaluated") {
    return;
  }
  const elapsed = context.tx.worldTick - record.state.startTick;
  if (elapsed < chapterLengthTicks) {
    return;
  }
  const meterRecord = readWorldState(context.tx, "meters", "meters", metersStateSchema);
  if (meterRecord === null) {
    return;
  }
  const meters = metersView(meterRecord.state);
  const statsRecord = readWorldState(context.tx, "chapter-stats", "chapter-stats", chapterStatsStateSchema);
  const stats: ChapterStatsState = statsRecord?.state ?? { fulfilled: 0, breached: 0 };
  const unmet: NumericMeterId[] = [];
  if (meters["relay.stability"] < 40) {
    unmet.push("relay.stability");
  }
  if (meters["orchard.water"] < 30) {
    unmet.push("orchard.water");
  }
  if (meters["migration.safety"] < 40) {
    unmet.push("migration.safety");
  }
  const outcome = unmet.length === 0 ? "equilibrium" : "strained";
  context.tx.emit(
    "ChapterStageEvaluated",
    {
      outcome,
      meters: metersSnapshot(meters),
      unmet,
      fulfilledCount: stats.fulfilled,
      breachedCount: stats.breached,
    },
    [{ kind: "public" }],
  );
  const campaign: CampaignState = { ...record.state, status: "evaluated", outcome };
  context.tx.put("campaign", "campaign", campaign);
}
