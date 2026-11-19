/**
 * 执行每日结算与章节评估：计算指标、消耗公共供给、触发阈值并写入结果事件。
 * 依赖世界/资源/地图端口、世界聚合与内容初始值；所有变化在 authority 提供的事务内完成。
 * 每日结算先在同一事务内检查全部目标库存再扣减；任一扣减或调整失败都抛 DomainError，
 * 由时钟步骤事务回滚，DayPassed 不提交，调用方可重试或停止。
 * 禁止重复结算同一 tick、在事务内调用模型或把未达标的指标算作均衡。
 */
import { DomainError, type Json, type MeterChange, type MeterChangeCause, type NumericMeterId, type ResourceId } from "@ai-npc/contracts";
import type { GameModulePorts, HandlerContext } from "@ai-npc/module-sdk";
import { requireGameContent, type MetersView } from "@ai-npc/module-sdk";
import { clampMeter, metersSnapshot, thresholdEvents } from "./meters";
import {
  campaignStateSchema,
  metersStateSchema,
  readWorldState,
  type CampaignState,
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

/** 每日结算的可失败写入失败：回滚整个结算事务，由调用方重试或停止。 */
function settlementFailure(message: string, details: Json): DomainError {
  return new DomainError("invalid-state", message, { retryable: true, details });
}

/**
 * 在同一事务内读取目标库存，按可用量（amount − reserved）截断应扣减的数量。
 * 返回 null 表示库存缺失或不可读；调用方必须在扣任何库存之前终止结算。
 */
function planDeduction(
  modules: GameModulePorts,
  stockpileId: string,
  resource: ResourceId,
  limit: number,
): number | null {
  const stockpile = modules["game.resources"].stockpile(stockpileId);
  if (stockpile === null) {
    return null;
  }
  // eslint-disable-next-line security/detect-object-injection -- 资源键来自受限枚举 ResourceId，金额记录使用固定键。
  const available = stockpile.amount[resource] - stockpile.reserved[resource];
  return Math.min(limit, Math.max(0, available));
}

/**
 * 在每日结算事务内执行一次；已结算的 tick 或未到结算日直接返回。
 * 供给扣减与果园医疗调整都按规则截断到可用量，先检查后执行；任一写入失败抛 DomainError 回滚。
 */
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
  // 先在同一事务内检查供给与果园医疗两个目标库存的可用量，再执行扣减。
  // 检查通过后写入仍可能失败时抛 DomainError，整个结算事务回滚，DayPassed 不提交。
  const supplyPlan = content.stockpiles.has("sp-commons")
    ? planDeduction(modules, "sp-commons", "supply", 6)
    : 0;
  if (supplyPlan === null) {
    throw settlementFailure("每日结算读取公共供给库存失败", { stockpileId: "sp-commons" });
  }
  const consumedSupply = supplyPlan;
  const orchardDamaged =
    next["orchard.water"] === 0 &&
    threshold.added.includes("OrchardDamaged") &&
    content.stockpiles.has("sp-flora");
  const orchardMedical = orchardDamaged ? planDeduction(modules, "sp-flora", "medical", 5) : 0;
  if (orchardMedical === null) {
    throw settlementFailure("每日结算读取果园医疗库存失败", { stockpileId: "sp-flora" });
  }

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

  if (consumedSupply > 0) {
    const consumed = modules["game.resources"].consume({
      stockpileId: "sp-commons",
      delta: { supply: consumedSupply, energy: 0, medical: 0 },
      reason: "daily-consumption",
      taskId: null,
      byId: "system:world",
      fromReservation: false,
    });
    if (!consumed.ok) {
      throw settlementFailure("每日供给扣减失败，结算事务已回滚", { reasonCode: consumed.reasonCode });
    }
  }
  if (consumedSupply < 6) {
    context.tx.emit("SupplyShortage", { value: consumedSupply }, [{ kind: "public" }]);
  }
  if (orchardMedical > 0) {
    const adjusted = modules["game.resources"].adjust({
      stockpileId: "sp-flora",
      delta: { medical: -orchardMedical },
      reason: "orchard-damage",
    });
    if (!adjusted.ok) {
      throw settlementFailure("果园损坏医疗调整失败，结算事务已回滚", { reasonCode: adjusted.reasonCode });
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
  const tick = context.tx.worldTick;
  const elapsed = tick - record.state.startTick;
  if (elapsed < chapterLengthTicks) {
    return;
  }
  const meterRecord = readWorldState(context.tx, "meters", "meters", metersStateSchema);
  if (meterRecord === null) {
    return;
  }
  const meters = metersView(meterRecord.state);
  // 协议计数由协议模块按已提交事实同步给出，不再读取异步事件的累计副本。
  const counts = context.modules["game.agreements"].countsAsOf(tick);
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
      fulfilledCount: counts.fulfilled,
      breachedCount: counts.breached,
    },
    [{ kind: "public" }],
  );
  const campaign: CampaignState = { ...record.state, status: "evaluated", outcome };
  context.tx.put("campaign", "campaign", campaign);
}
