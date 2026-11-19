/**
 * 168 tick 世界验收的共享脚本：固定命令序列、逐 tick 宿主推进、事件投影与只读事实读取。
 * 依赖真实 SQLite 游戏环境、服务端 tick 顺序与确定性宿主随机源。
 * 禁止绕过命令网关或宿主顺序手写 job/时钟/消费者调用，也禁止让墙钟时间影响结果。
 */
import type { AuthContext, CommandReceipt, CommandType, Json } from "@ai-npc/contracts";
import { advanceWorldTick } from "@ai-npc/app-server";
import {
  createTrackedGameHarness,
  gameCommandEnvelope,
  playerAuth,
  readBranchWorldRows,
  readGameAggregate,
  readGameEvents,
  startNeutralCampaign,
  strategicAuth,
  type GameHarness,
} from "../integration/game-support";

/** 首章最后一个 tick：tick 0–167 为七天，tick 168 提交章节评估。 */
export const CHAPTER_END_TICK = 168;

/** 标准剧情节奏的卡片触发 tick；内容包 watergate-v1 的 trigger.atTick 固定值。 */
export const STANDARD_CARD_TICKS: Readonly<Record<string, number>> = {
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
export const ESCALATING_RATE = 0.75;

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

export type WorldEvent = ReturnType<typeof readGameEvents>[number];

export interface ScriptedReceipt {
  readonly label: string;
  readonly receipt: CommandReceipt;
}

export interface WorldScriptRun {
  readonly receipts: readonly ScriptedReceipt[];
  readonly transportTaskId: string;
  readonly fulfilledAgreementId: string;
  readonly breachedAgreementId: string;
}

export interface ResourceAmounts {
  readonly supply: number;
  readonly energy: number;
  readonly medical: number;
}

export interface StockpileView {
  readonly amount: ResourceAmounts;
  readonly reserved: ResourceAmounts;
  readonly baseline: ResourceAmounts;
}

export interface MeterSnapshot {
  readonly "relay.stability": number;
  readonly "orchard.water": number;
  readonly "migration.safety": number;
  readonly "watergate.allocation": "harbor-first" | "rotation" | "orchard-first";
}

export interface DayPassedPayload {
  readonly day: number;
  readonly meters: MeterSnapshot;
  readonly consumption: ResourceAmounts;
}

export interface ChapterPayload {
  readonly outcome: "equilibrium" | "strained";
  readonly meters: MeterSnapshot;
  readonly unmet: readonly string[];
  readonly fulfilledCount: number;
  readonly breachedCount: number;
}

export interface MeterChange {
  readonly meter: string;
  readonly from: number;
  readonly to: number;
  readonly cause: string;
}

/** 回执被拒绝时立刻失败，避免后续命令在缺失 ID 的情况下继续。 */
export function requireAccepted(label: string, receipt: CommandReceipt): CommandReceipt {
  if (receipt.commandStatus !== "accepted") {
    throw new Error(`脚本命令 ${label} 被拒绝，原因码 ${String(receipt.reasonCode)}`);
  }
  return receipt;
}

/** 读取 accepted 回执结果中的动态 ID；缺失时明确失败。 */
export function requireResultId(receipt: CommandReceipt, key: string): string {
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
export function runWorldScript(harness: GameHarness): WorldScriptRun {
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
export function advanceToTick(harness: GameHarness, targetTick: number): void {
  for (let tick = 1; tick <= targetTick; tick += 1) {
    const result = advanceWorldTick({
      storage: harness.storage,
      authority: harness.authority,
      clock: harness.clock,
      branchId: harness.branchId,
      targetTick: tick,
    });
    if (result.worldTick !== tick) {
      throw new Error(`tick 推进返回 ${result.worldTick}，期望 ${tick}`);
    }
  }
}

/** 创建 harness 并连续推进到章节末；用于只需要终局世界的验收用例。 */
export async function createWorldAtChapterEnd(
  active: GameHarness[],
  options: Parameters<typeof createTrackedGameHarness>[1] = {},
): Promise<GameHarness> {
  const harness = await createTrackedGameHarness(active, options);
  runWorldScript(harness);
  advanceToTick(harness, CHAPTER_END_TICK);
  return harness;
}

export function eventsOf(events: readonly WorldEvent[], type: string): readonly WorldEvent[] {
  return events.filter((event) => event.type === type);
}

/** 按 cardId 汇总剧情卡触发 tick；重复触发直接失败。 */
export function cardTriggerTicks(events: readonly WorldEvent[]): ReadonlyMap<string, number> {
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
export function chapterEvent(events: readonly WorldEvent[]): WorldEvent {
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

export function chapterPayload(events: readonly WorldEvent[]): ChapterPayload {
  return chapterEvent(events).payload as unknown as ChapterPayload;
}

export function stockpile(harness: GameHarness, stockpileId: string): StockpileView {
  const state = readGameAggregate(harness, "stockpile", stockpileId);
  if (state === null) {
    throw new Error(`库存 ${stockpileId} 不存在`);
  }
  return state as unknown as StockpileView;
}

/** 从开局事件里找到玩家的委托 ID；内容包只为玩家写一条开局委托。 */
export function playerDelegationId(events: readonly WorldEvent[]): string {
  for (const event of eventsOf(events, "DelegationCreated")) {
    const payload = event.payload as { readonly delegationId?: unknown; readonly granteeId?: unknown };
    if (payload.granteeId === "player-1" && typeof payload.delegationId === "string") {
      return payload.delegationId;
    }
  }
  throw new Error("没有找到玩家的开局委托");
}

/** 读取当前分支时钟的 world_tick；缺失时明确失败。 */
export function readClockTick(harness: GameHarness): number {
  const rows = readBranchWorldRows(harness.storage, harness.branchId);
  const tick = rows.clock?.["world_tick"];
  if (typeof tick !== "number") {
    throw new Error(`分支 ${harness.branchId} 缺少 clock.world_tick`);
  }
  return tick;
}

/** 事件序列的稳定投影：只保留类型、提交 tick、payload 与受众。 */
export function eventSequence(harness: GameHarness): readonly {
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
export function stableWorldFacts(harness: GameHarness): Json {
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
export function meterChanges(harness: GameHarness, cause: string): readonly MeterChange[] {
  return readGameEvents(harness)
    .filter((event) => event.type === "MetersChanged")
    .flatMap((event) => (event.payload as unknown as { readonly changes: readonly MeterChange[] }).changes)
    .filter((change) => change.cause === cause);
}
